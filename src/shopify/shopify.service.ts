import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { ILike } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';

// ── Sync record — snapshot of one completed sync run ─────────────────────────
interface SyncRecord {
  completedAt: string;
  inserted: number;
  changed: number;
  verified: number;
  skippedSyncIgnored: number;
  skippedMissingSku: number;
  skippedMissingPrice: number;
  skippedInactive: number;
  skippedInvalid: number;
  skippedDuplicateSku: number;
  errors: number;
  rawVariants: number;
  fetchedProducts: number;
  fetchedVariants: number;
  durationMs: number;
  error: string | null;
  reconciled: boolean;
}

// Module-level sync state — persists across requests, resets on server restart
let syncStatus = {
  total: 0,
  processed: 0,
  inserted: 0,
  changed: 0,
  verified: 0,
  skipped: 0,
  errors: 0,
  status: 'idle' as 'idle' | 'running' | 'done',
  phase: 'idle' as 'idle' | 'fetching' | 'saving' | 'done',
  lastError: '',
  lastSyncAt: null as string | null,
  lastSuccessfulSyncAt: null as string | null,
  lastSyncType: null as 'full' | 'incremental' | null,
  startedAt: null as string | null,
  durationMs: null as number | null,
  fetchedProducts: 0,
  rawVariants: 0,
  skippedSyncIgnored: 0,
  skippedMissingSku: 0,
  skippedMissingPrice: 0,
  skippedInactive: 0,
  skippedInvalid: 0,
  skippedDuplicateSku: 0,
  reconciled: null as boolean | null,
  autoSync: null as SyncRecord | null,
  manualSync: null as SyncRecord | null,
};

export function isShopifyConfigured(): boolean {
  return !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN);
}

export function getSyncStatus() {
  return { ...syncStatus, shopifyConfigured: isShopifyConfigured() };
}

function classifyError(err: any): string {
  const msg = err?.message ?? '';
  const code = err?.code ?? '';
  const status = err?.response?.status ?? 0;
  if (
    msg.includes('SHOPIFY_STORE') ||
    msg.includes('SHOPIFY_ACCESS_TOKEN') ||
    !isShopifyConfigured()
  ) {
    return 'Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN on the server (see ecosystem.config.js)';
  }
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    msg.includes('timeout')
  ) {
    return 'Shopify API timeout — network slow or Shopify unreachable';
  }
  if (status === 401 || status === 403) {
    return 'Authentication failed — verify SHOPIFY_ACCESS_TOKEN is correct';
  }
  if (status === 429) {
    return 'Rate limited by Shopify API — retry in a few minutes';
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
    return 'Cannot reach Shopify — check network or SHOPIFY_STORE value';
  }
  if (status >= 500) {
    return `Shopify server error (HTTP ${status}) — may be a temporary outage`;
  }
  return msg || 'Unknown sync error';
}

// ── Knowledge field helpers ───────────────────────────────────────────────────

// Strips HTML from Shopify body_html and returns clean plain text.
// Returns null when the result is empty after stripping.
export function cleanDescription(html: string): string | null {
  if (!html?.trim()) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

// Trims, lowercases, and deduplicates a Shopify comma-separated tag string.
// "optical, lens , Edging, optical" → "optical,lens,edging"
// Returns null when no tags remain after normalization.
export function normalizeTags(raw: string): string | null {
  if (!raw?.trim()) return null;
  const seen = new Set<string>();
  const tags = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && !seen.has(t) && (seen.add(t), true));
  return tags.length > 0 ? tags.join(',') : null;
}

// ── Valid variant shape (returned by flattenToVariants) ───────────────────────
interface ValidVariant {
  shopifyProductId: string;
  variantId: string;
  title: string;
  sku: string;
  price: number;
  image: string;
  inventoryItemId: string;
  shopifyUpdatedAt: string;
  // Knowledge fields — product-level, shared by all variants of the same product
  handle: string | null;
  description: string | null;
  tags: string | null;
  vendor: string | null;
  productType: string | null;
}

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
  ) {}

  // ── Fetch active products from Shopify (paginated) ─────────────────────────
  async getProducts(updatedSince?: string): Promise<any[]> {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!store || !token) {
      throw new Error(
        'SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env',
      );
    }

    const mode = updatedSince ? `incremental (since ${updatedSince})` : 'full';
    this.logger.log(`[SYNC] Starting ${mode} product fetch — store: ${store}`);

    const allProducts: any[] = [];
    let since_id: string | undefined;
    let page = 0;

    while (true) {
      page++;
      const params = new URLSearchParams({ limit: '250', status: 'active' });
      if (since_id) params.set('since_id', since_id);
      if (updatedSince) params.set('updated_at_min', updatedSince);

      const url = `https://${store}/admin/api/2023-10/products.json?${params.toString()}`;
      this.logger.log(
        `[SYNC] Page ${page} — ${since_id ? `since_id=${since_id}` : 'first page'}`,
      );

      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 30000,
      });

      const products: any[] = (response.data as any)?.products ?? [];
      this.logger.log(
        `[SYNC] Page ${page}: received ${products.length} products`,
      );

      if (products.length === 0) break;

      allProducts.push(...products);
      since_id = String(products[products.length - 1].id);
    }

    this.logger.log(
      `[SYNC] Fetch complete — total products: ${allProducts.length} across ${page} page(s)`,
    );
    return allProducts;
  }

  private parseProductTitle(raw: string): { cleanTitle: string } {
    const idx = raw.lastIndexOf(' - ');
    if (idx === -1) return { cleanTitle: raw.trim() };
    return { cleanTitle: raw.slice(0, idx).trim() };
  }

  // Returns valid variants plus per-reason skip counts so callers can reconcile totals.
  // Knowledge fields (handle, description, tags, vendor, productType) are product-level
  // and shared across all variants of the same product.
  private flattenToVariants(products: any[]): {
    valid: ValidVariant[];
    rawVariantCount: number;
    skippedInactive: number;
    skippedInvalid: number;
    skippedMissingSku: number;
    skippedMissingPrice: number;
  } {
    let rawVariantCount = 0;
    let skippedInactive = 0;
    let skippedInvalid = 0;
    let skippedMissingSku = 0;
    let skippedMissingPrice = 0;
    const valid: ValidVariant[] = [];

    for (const p of products) {
      const variantsArr: any[] = p.variants ?? [];
      rawVariantCount += variantsArr.length;

      const pStatus = (p.status ?? 'active').toLowerCase();
      if (pStatus !== 'active') {
        this.logger.warn(
          `[SYNC SKIP] Product "${p.title}" status=${p.status} — ${variantsArr.length} variant(s) excluded (inactive)`,
        );
        skippedInactive += variantsArr.length;
        continue;
      }

      const cleanTitle = this.parseProductTitle(
        (p.title ?? '').trim(),
      ).cleanTitle;
      if (!cleanTitle) {
        this.logger.warn(
          `[SYNC SKIP] Product ID ${p.id} missing title — ${variantsArr.length} variant(s) excluded (invalid)`,
        );
        skippedInvalid += variantsArr.length;
        continue;
      }

      const imageMap: Record<string, string> = {};
      for (const img of p.images ?? []) {
        if (img.id && img.src) imageMap[String(img.id)] = img.src;
      }
      const productImage: string = p.image?.src ?? p.images?.[0]?.src ?? '';

      // Extract product-level knowledge fields once per product
      const handle = (p.handle ?? '').trim() || null;
      const description = cleanDescription(p.body_html ?? '');
      const tags = normalizeTags(p.tags ?? '');
      const vendor = (p.vendor ?? '').trim() || null;
      const productType = (p.product_type ?? '').trim() || null;

      for (const v of variantsArr) {
        const variantImage: string =
          v.image_id && imageMap[String(v.image_id)]
            ? imageMap[String(v.image_id)]
            : productImage;

        const sku = (v.sku ?? '').trim();
        const price = Number(v.price ?? 0);

        if (!sku) {
          this.logger.warn(
            `[SYNC SKIP] Product "${cleanTitle}" variant ${v.id} — missing SKU`,
          );
          skippedMissingSku++;
          continue;
        }
        if (price <= 0) {
          this.logger.warn(
            `[SYNC SKIP] Product "${cleanTitle}" SKU "${sku}" — price=0 or missing`,
          );
          skippedMissingPrice++;
          continue;
        }
        if (!variantImage) {
          this.logger.warn(
            `[SYNC WARN] Product "${cleanTitle}" SKU "${sku}" — no image (syncing with empty)`,
          );
        }

        valid.push({
          shopifyProductId: String(p.id),
          variantId: String(v.id),
          title: cleanTitle,
          sku,
          price,
          image: variantImage,
          inventoryItemId: v.inventory_item_id
            ? String(v.inventory_item_id)
            : '',
          shopifyUpdatedAt: v.updated_at ? String(v.updated_at) : '',
          handle,
          description,
          tags,
          vendor,
          productType,
        });
      }
    }

    return {
      valid,
      rawVariantCount,
      skippedInactive,
      skippedInvalid,
      skippedMissingSku,
      skippedMissingPrice,
    };
  }

  @Cron('0 21 * * *')
  async scheduledSync() {
    if (syncStatus.status === 'running') {
      this.logger.warn(
        '[AUTO-SYNC] Skipping — another sync is already running',
      );
      return;
    }
    this.logger.log('[AUTO-SYNC] Starting scheduled daily incremental sync');
    const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await this.syncProducts({
      mode: 'incremental',
      updatedSince: cutoff,
      trigger: 'auto',
    });
  }

  async syncProducts(
    opts: {
      mode?: 'full' | 'incremental';
      updatedSince?: string;
      trigger?: 'auto' | 'manual';
    } = {},
  ): Promise<{
    fetched: number;
    variants: number;
    inserted: number;
    changed: number;
    verified: number;
    skipped: number;
    errors: number;
    durationMs: number;
    error?: string;
  }> {
    const syncType = opts.mode ?? 'full';
    const trigger = opts.trigger ?? 'manual';
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    syncStatus = {
      total: 0,
      processed: 0,
      inserted: 0,
      changed: 0,
      verified: 0,
      skipped: 0,
      errors: 0,
      status: 'running',
      phase: 'fetching',
      lastError: '',
      lastSyncAt: syncStatus.lastSyncAt,
      lastSuccessfulSyncAt: syncStatus.lastSuccessfulSyncAt,
      lastSyncType: syncStatus.lastSyncType,
      startedAt,
      durationMs: null,
      fetchedProducts: 0,
      rawVariants: 0,
      skippedSyncIgnored: 0,
      skippedMissingSku: 0,
      skippedMissingPrice: 0,
      skippedInactive: 0,
      skippedInvalid: 0,
      skippedDuplicateSku: 0,
      reconciled: null,
      autoSync: syncStatus.autoSync,
      manualSync: syncStatus.manualSync,
    };

    let inserted = 0;
    let changed = 0;
    let verified = 0;
    const skipped = 0;
    let errors = 0;

    try {
      const rawProducts = await this.getProducts(opts.updatedSince);
      this.logger.log(
        `[SYNC] Fetched ${rawProducts.length} active products from Shopify (${syncType})`,
      );

      syncStatus.fetchedProducts = rawProducts.length;

      const {
        valid: variants,
        rawVariantCount,
        skippedInactive,
        skippedInvalid,
        skippedMissingSku,
        skippedMissingPrice,
      } = this.flattenToVariants(rawProducts);

      const preSaveSkipped =
        skippedInactive +
        skippedInvalid +
        skippedMissingSku +
        skippedMissingPrice;

      this.logger.log(
        `[SYNC] Raw variants: ${rawVariantCount} | Valid: ${variants.length} | Pre-save excluded: ${preSaveSkipped} (inactive=${skippedInactive} invalid=${skippedInvalid} noSku=${skippedMissingSku} noPrice=${skippedMissingPrice})`,
      );

      syncStatus.rawVariants = rawVariantCount;
      syncStatus.skippedInactive = skippedInactive;
      syncStatus.skippedInvalid = skippedInvalid;
      syncStatus.skippedMissingSku = skippedMissingSku;
      syncStatus.skippedMissingPrice = skippedMissingPrice;
      syncStatus.total = variants.length;
      syncStatus.phase = 'saving';

      const seenSkus = new Set<string>();
      let skippedSyncIgnored = 0;
      let skippedDuplicateSku = 0;

      for (const v of variants) {
        try {
          if (seenSkus.has(v.sku)) {
            this.logger.warn(
              `[SYNC:DUPLICATE] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId} — duplicate in this run, skipping`,
            );
            skippedDuplicateSku++;
            syncStatus.skippedDuplicateSku = skippedDuplicateSku;
            syncStatus.skipped =
              preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
            continue;
          }
          seenSkus.add(v.sku);

          let existing = await this.catalogRepo.findOneBy({
            shopifyVariantId: v.variantId,
          });
          if (!existing) {
            existing = await this.catalogRepo.findOneBy({ sku: v.sku });
          }

          if (existing) {
            if (existing.syncIgnored) {
              this.logger.debug(
                `[SYNC:IGNORED] sku="${v.sku}" variantId=${v.variantId} id=${existing.id}`,
              );
              skippedSyncIgnored++;
              syncStatus.skippedSyncIgnored = skippedSyncIgnored;
              syncStatus.skipped =
                preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
              continue;
            }

            const incomingImage = v.image || existing.image || '';
            const itemCodeBackfill =
              existing.itemCode === `SP_${v.variantId}`
                ? `SP_${v.shopifyProductId}_${v.variantId}`
                : existing.itemCode;

            const nameChanged = existing.itemName !== v.title;
            const skuChanged = existing.sku !== v.sku;
            const priceChanged = Number(existing.sellingPrice) !== v.price;
            const imageChanged = !!v.image && existing.image !== v.image;
            const itemCodeChanged = itemCodeBackfill !== existing.itemCode;
            const handleChanged = existing.handle !== v.handle;
            const descriptionChanged = existing.description !== v.description;
            const tagsChanged = existing.tags !== v.tags;
            const vendorChanged = existing.vendor !== v.vendor;
            const productTypeChanged = existing.productType !== v.productType;

            if (
              nameChanged ||
              skuChanged ||
              priceChanged ||
              imageChanged ||
              itemCodeChanged ||
              handleChanged ||
              descriptionChanged ||
              tagsChanged ||
              vendorChanged ||
              productTypeChanged
            ) {
              if (skuChanged) {
                this.logger.warn(
                  `[SYNC WARNING] SKU changed: "${existing.sku}" → "${v.sku}" (variantId=${v.variantId})`,
                );
              }
              await this.catalogRepo.update(
                { id: existing.id },
                {
                  itemName: v.title,
                  sku: v.sku,
                  sellingPrice: v.price,
                  retailPrice: v.price,
                  image: incomingImage,
                  shopifyProductId: v.shopifyProductId,
                  shopifyVariantId: v.variantId,
                  shopifyInventoryItemId:
                    v.inventoryItemId || existing.shopifyInventoryItemId || '',
                  shopifyUpdatedAt: v.shopifyUpdatedAt
                    ? new Date(v.shopifyUpdatedAt)
                    : existing.shopifyUpdatedAt,
                  handle: v.handle,
                  description: v.description,
                  tags: v.tags,
                  vendor: v.vendor,
                  productType: v.productType,
                  ...(itemCodeChanged ? { itemCode: itemCodeBackfill } : {}),
                },
              );
              changed++;
              this.logger.debug(
                `[SYNC:CHANGED] sku="${v.sku}" id=${existing.id}`,
              );
            } else {
              verified++;
              this.logger.debug(
                `[SYNC:VERIFIED] sku="${v.sku}" id=${existing.id}`,
              );
            }
          } else {
            await this.catalogRepo.save({
              itemCode: `SP_${v.shopifyProductId}_${v.variantId}`,
              shopifyProductId: v.shopifyProductId,
              shopifyVariantId: v.variantId,
              shopifyInventoryItemId: v.inventoryItemId || '',
              shopifyUpdatedAt: v.shopifyUpdatedAt
                ? new Date(v.shopifyUpdatedAt)
                : null,
              itemName: v.title,
              sku: v.sku,
              sellingPrice: v.price,
              retailPrice: v.price,
              wholesalePrice: 0,
              image: v.image || '',
              unit: 'Nos',
              hsnCode: '',
              gst: 0,
              costPrice: 0,
              syncIgnored: false,
              source: 'SHOPIFY',
              handle: v.handle,
              description: v.description,
              tags: v.tags,
              vendor: v.vendor,
              productType: v.productType,
            });
            inserted++;
            this.logger.debug(
              `[SYNC:ADDED] sku="${v.sku}" variantId=${v.variantId}`,
            );
          }

          syncStatus.processed = inserted + changed;
          syncStatus.inserted = inserted;
          syncStatus.changed = changed;
          syncStatus.verified = verified;
        } catch (itemErr: any) {
          errors++;
          syncStatus.errors = errors;
          this.logger.error(`[ERROR] sku="${v.sku}": ${itemErr.message}`);
        }
      }

      const totalSkipped =
        preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
      const totalAccountedFor =
        inserted + changed + verified + totalSkipped + errors;
      const reconciled = totalAccountedFor === rawVariantCount;
      syncStatus.reconciled = reconciled;

      if (!reconciled) {
        this.logger.error(
          `[SYNC] ⚠ RECONCILIATION MISMATCH: ${rawVariantCount} raw ≠ ${totalAccountedFor} accounted (gap: ${rawVariantCount - totalAccountedFor})`,
        );
      } else {
        this.logger.log(
          `[SYNC] Reconciliation: ${rawVariantCount} = ${inserted}+${changed}+${verified}+${totalSkipped}+${errors} ✓`,
        );
      }

      const durationMs = Date.now() - startMs;
      const now = new Date().toISOString();

      const record: SyncRecord = {
        completedAt: now,
        inserted,
        changed,
        verified,
        errors,
        skippedSyncIgnored,
        skippedMissingSku,
        skippedMissingPrice,
        skippedInactive,
        skippedInvalid,
        skippedDuplicateSku,
        rawVariants: rawVariantCount,
        fetchedProducts: rawProducts.length,
        fetchedVariants: variants.length,
        durationMs,
        error:
          errors > 0 ? `${errors} variant error${errors > 1 ? 's' : ''}` : null,
        reconciled,
      };

      syncStatus.status = 'done';
      syncStatus.phase = 'done';
      syncStatus.processed = inserted + changed;
      syncStatus.inserted = inserted;
      syncStatus.changed = changed;
      syncStatus.verified = verified;
      syncStatus.skippedSyncIgnored = skippedSyncIgnored;
      syncStatus.skippedDuplicateSku = skippedDuplicateSku;
      syncStatus.skipped = totalSkipped;
      syncStatus.errors = errors;
      syncStatus.durationMs = durationMs;
      syncStatus.lastSyncAt = now;
      syncStatus.lastSuccessfulSyncAt = now;
      syncStatus.lastSyncType = syncType;
      if (trigger === 'auto') syncStatus.autoSync = record;
      else syncStatus.manualSync = record;

      this.logger.log(
        `[SYNC] ✅ Complete (${syncType}/${trigger}): raw=${rawVariantCount} valid=${variants.length} inserted=${inserted} changed=${changed} verified=${verified} skipped=${totalSkipped} errors=${errors} reconciled=${reconciled} duration=${durationMs}ms`,
      );

      return {
        fetched: rawProducts.length,
        variants: variants.length,
        inserted,
        changed,
        verified,
        skipped: totalSkipped,
        errors,
        durationMs,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startMs;
      const readable = classifyError(error);
      this.logger.error(`[SYNC] ❌ Fatal: ${readable}`, error.stack);

      const failRecord: SyncRecord = {
        completedAt: new Date().toISOString(),
        inserted: 0,
        changed: 0,
        verified: 0,
        errors: 1,
        skippedSyncIgnored: 0,
        skippedMissingSku: 0,
        skippedMissingPrice: 0,
        skippedInactive: 0,
        skippedInvalid: 0,
        skippedDuplicateSku: 0,
        rawVariants: 0,
        fetchedProducts: 0,
        fetchedVariants: 0,
        durationMs,
        error: readable,
        reconciled: false,
      };

      syncStatus.status = 'done';
      syncStatus.phase = 'done';
      syncStatus.lastError = readable;
      syncStatus.durationMs = durationMs;
      syncStatus.lastSyncAt = new Date().toISOString();
      syncStatus.lastSyncType = syncType;
      if (trigger === 'auto') syncStatus.autoSync = failRecord;
      else syncStatus.manualSync = failRecord;

      return {
        fetched: 0,
        variants: 0,
        inserted: 0,
        changed: 0,
        verified: 0,
        skipped: 0,
        errors: 1,
        durationMs,
        error: readable,
      };
    }
  }

  // ── Backfill knowledge fields on existing catalog items ─────────────────────
  // Fetches all active Shopify products and patches description/tags/vendor/
  // productType/handle on every matching catalog row (syncIgnored rows skipped).
  // Only touches these 5 fields — does NOT change prices, names, or SKUs.
  // Safe to run multiple times; already-populated rows simply get re-confirmed.
  async backfillKnowledgeFields(): Promise<{
    products: number;
    itemsUpdated: number;
    itemsWithDesc: number;
    itemsWithTags: number;
    itemsWithVendor: number;
    itemsWithType: number;
    errors: number;
    durationMs: number;
  }> {
    const startMs = Date.now();
    this.logger.log('[BACKFILL] Starting knowledge field backfill');

    const rawProducts = await this.getProducts();
    this.logger.log(
      `[BACKFILL] Fetched ${rawProducts.length} products from Shopify`,
    );

    let itemsUpdated = 0;
    let itemsWithDesc = 0;
    let itemsWithTags = 0;
    let itemsWithVendor = 0;
    let itemsWithType = 0;
    let errors = 0;

    for (const p of rawProducts) {
      const productId = String(p.id);
      const handle = (p.handle ?? '').trim() || null;
      const description = cleanDescription(p.body_html ?? '');
      const tags = normalizeTags(p.tags ?? '');
      const vendor = (p.vendor ?? '').trim() || null;
      const productType = (p.product_type ?? '').trim() || null;

      try {
        const result = await this.catalogRepo.update(
          { shopifyProductId: productId, syncIgnored: false },
          { handle, description, tags, vendor, productType },
        );
        const affected = result.affected ?? 0;
        itemsUpdated += affected;
        if (description) itemsWithDesc += affected;
        if (tags) itemsWithTags += affected;
        if (vendor) itemsWithVendor += affected;
        if (productType) itemsWithType += affected;
      } catch (err: any) {
        errors++;
        this.logger.error(`[BACKFILL] product ${productId}: ${err.message}`);
      }
    }

    const durationMs = Date.now() - startMs;
    this.logger.log(
      `[BACKFILL] ✅ Done — products=${rawProducts.length} items_updated=${itemsUpdated} errors=${errors} duration=${durationMs}ms`,
    );

    return {
      products: rawProducts.length,
      itemsUpdated,
      itemsWithDesc,
      itemsWithTags,
      itemsWithVendor,
      itemsWithType,
      errors,
      durationMs,
    };
  }

  // ── Knowledge coverage report ────────────────────────────────────────────────
  // Reads catalog items (non-ignored) and reports how many have each knowledge
  // field populated. Used to assess Promotion AI input quality.
  async getKnowledgeReport(): Promise<{
    total: number;
    withDescription: number;
    withTags: number;
    withVendor: number;
    withProductType: number;
    withHandle: number;
    withAnyKnowledge: number;
    withAllKnowledge: number;
    coveragePct: number;
    fullCoveragePct: number;
  }> {
    // Load only knowledge-relevant columns — TypeORM select+where misbehaves when the
    // where field isn't in the select list, so we filter syncIgnored in TypeScript.
    const items = await this.catalogRepo.find({
      where: { syncIgnored: false },
    });

    const total = items.length;
    const withDescription = items.filter((i) => i.description).length;
    const withTags = items.filter((i) => i.tags).length;
    const withVendor = items.filter((i) => i.vendor).length;
    const withProductType = items.filter((i) => i.productType).length;
    const withHandle = items.filter((i) => i.handle).length;
    const withAnyKnowledge = items.filter(
      (i) => i.description || i.tags || i.vendor || i.productType,
    ).length;
    const withAllKnowledge = items.filter(
      (i) => i.description && i.tags && i.vendor && i.productType,
    ).length;
    const coveragePct =
      total > 0 ? Math.round((withAnyKnowledge / total) * 100) : 0;
    const fullCoveragePct =
      total > 0 ? Math.round((withAllKnowledge / total) * 100) : 0;

    return {
      total,
      withDescription,
      withTags,
      withVendor,
      withProductType,
      withHandle,
      withAnyKnowledge,
      withAllKnowledge,
      coveragePct,
      fullCoveragePct,
    };
  }

  // ── Item lookup by SKU — exact match first, then ILIKE prefix fallback ───────
  async getItemBySku(sku: string) {
    const needle = sku.trim();
    let found = await this.catalogRepo.findOneBy({ sku: ILike(needle) });
    if (!found) {
      found = await this.catalogRepo.findOne({
        where: { sku: ILike(`${needle}%`) },
        order: { sku: 'ASC' },
      });
    }
    if (!found) return null;
    return {
      sku: found.sku,
      itemName: found.itemName,
      price: Number(found.sellingPrice),
      image: found.image || null,
      gst: Number(found.gst) || 0,
    };
  }
}

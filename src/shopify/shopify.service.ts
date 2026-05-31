import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILike } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';

// ── Sync record — snapshot of one completed sync run ─────────────────────────
// Terminology:
//   inserted           = new DB rows created this run
//   changed            = existing rows with at least one field change written
//   verified           = existing rows processed, already current (no DB write)
//   skippedSyncIgnored = hidden by ops team (syncIgnored=true)
//   skippedMissingSku  = Shopify variant has no SKU
//   skippedMissingPrice= Shopify variant price = 0
//   skippedInactive    = product status != active (defensive; API already filters)
//   skippedInvalid     = product missing title or otherwise malformed
//   skippedDuplicateSku= duplicate SKU within this sync run (2nd+ occurrence skipped)
//   rawVariants        = total Shopify variants before ANY filtering
//   reconciled         = rawVariants === inserted+changed+verified+allSkipped+errors
interface SyncRecord {
  completedAt:         string;
  inserted:            number;
  changed:             number;
  verified:            number;
  skippedSyncIgnored:  number;
  skippedMissingSku:   number;
  skippedMissingPrice: number;
  skippedInactive:     number;
  skippedInvalid:      number;
  skippedDuplicateSku: number;
  errors:              number;
  rawVariants:         number;
  fetchedProducts:     number;
  fetchedVariants:     number;   // valid variants passed to save loop
  durationMs:          number;
  error:               string | null;
  reconciled:          boolean;
}

// Module-level sync state — persists across requests, resets on server restart
let syncStatus = {
  total:         0,   // valid variants passed to save loop (current run)
  processed:     0,   // inserted + changed so far
  inserted:      0,
  changed:       0,   // existing rows with actual field changes written
  verified:      0,   // existing rows checked but already current
  skipped:       0,   // TOTAL skipped (all reasons) — for backward compat + reconciliation
  errors:        0,
  status:        'idle'    as 'idle' | 'running' | 'done',
  phase:         'idle'    as 'idle' | 'fetching' | 'saving' | 'done',
  lastError:     '',
  lastSyncAt:            null as string | null,
  lastSuccessfulSyncAt:  null as string | null,
  lastSyncType:          null as 'full' | 'incremental' | null,
  startedAt:             null as string | null,
  durationMs:            null as number | null,
  fetchedProducts:       0,
  rawVariants:           0,   // total Shopify variants before any filtering
  // Skip breakdown
  skippedSyncIgnored:    0,
  skippedMissingSku:     0,
  skippedMissingPrice:   0,
  skippedInactive:       0,
  skippedInvalid:        0,   // missing title / malformed product
  skippedDuplicateSku:   0,
  reconciled:            null as boolean | null,
  // Separate history slots so the UI can always show both
  autoSync:   null as SyncRecord | null,
  manualSync: null as SyncRecord | null,
};

export function isShopifyConfigured(): boolean {
  return !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN);
}

export function getSyncStatus() {
  return { ...syncStatus, shopifyConfigured: isShopifyConfigured() };
}

// ── Classify axios/network errors into readable operational messages ─────────
function classifyError(err: any): string {
  const msg    = err?.message ?? '';
  const code   = err?.code ?? '';
  const status = err?.response?.status ?? 0;
  // Configuration missing — check this first so it is never masked by other branches
  if (msg.includes('SHOPIFY_STORE') || msg.includes('SHOPIFY_ACCESS_TOKEN') || !isShopifyConfigured()) {
    return 'Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN on the server (see ecosystem.config.js)';
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || msg.includes('timeout')) {
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

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
  ) {}

  // ── Fetch active products from Shopify (paginated) ──────────────────────
  // updatedSince: ISO timestamp — when set, only returns products updated after that time (incremental mode)
  async getProducts(updatedSince?: string): Promise<any[]> {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!store || !token) {
      throw new Error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env');
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
      this.logger.log(`[SYNC] Page ${page} — ${since_id ? `since_id=${since_id}` : 'first page'}`);

      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 30000,
      });

      const products: any[] = (response.data as any)?.products ?? [];
      this.logger.log(`[SYNC] Page ${page}: received ${products.length} products`);

      if (products.length === 0) break;

      allProducts.push(...products);
      since_id = String(products[products.length - 1].id);
    }

    this.logger.log(`[SYNC] Fetch complete — total products: ${allProducts.length} across ${page} page(s)`);
    return allProducts;
  }

  private parseProductTitle(raw: string): { cleanTitle: string } {
    const idx = raw.lastIndexOf(' - ');
    if (idx === -1) return { cleanTitle: raw.trim() };
    return { cleanTitle: raw.slice(0, idx).trim() };
  }

  // Returns valid variants plus per-reason skip counts so callers can reconcile totals.
  // Required fields: title, SKU, price. Image is optional — syncs with '' if both
  // variant and product images are missing (placeholder shown in UI).
  // inventoryItemId and shopifyUpdatedAt are traceability fields — always passed through.
  private flattenToVariants(products: any[]): {
    valid: Array<{
      shopifyProductId:  string;
      variantId:         string;
      title:             string;
      sku:               string;
      price:             number;
      image:             string;
      inventoryItemId:   string;   // Shopify inventory_item_id — for future inventory sync
      shopifyUpdatedAt:  string;   // Shopify variant updated_at — incremental sync validation
    }>;
    rawVariantCount:     number;
    skippedInactive:     number;
    skippedInvalid:      number;
    skippedMissingSku:   number;
    skippedMissingPrice: number;
  } {
    let rawVariantCount    = 0;
    let skippedInactive    = 0;
    let skippedInvalid     = 0;
    let skippedMissingSku  = 0;
    let skippedMissingPrice = 0;
    const valid: Array<{
      shopifyProductId:  string;
      variantId:         string;
      title:             string;
      sku:               string;
      price:             number;
      image:             string;
      inventoryItemId:   string;
      shopifyUpdatedAt:  string;
    }> = [];

    for (const p of products) {
      const variantsArr: any[] = p.variants ?? [];
      rawVariantCount += variantsArr.length;

      // Defensive status guard — API uses status=active but verify here too
      const pStatus = (p.status ?? 'active').toLowerCase();
      if (pStatus !== 'active') {
        this.logger.warn(`[SYNC SKIP] Product "${p.title}" status=${p.status} — ${variantsArr.length} variant(s) excluded (inactive)`);
        skippedInactive += variantsArr.length;
        continue;
      }

      const cleanTitle = this.parseProductTitle((p.title ?? '').trim()).cleanTitle;
      if (!cleanTitle) {
        this.logger.warn(`[SYNC SKIP] Product ID ${p.id} missing title — ${variantsArr.length} variant(s) excluded (invalid)`);
        skippedInvalid += variantsArr.length;
        continue;
      }

      const imageMap: Record<string, string> = {};
      for (const img of p.images ?? []) {
        if (img.id && img.src) imageMap[String(img.id)] = img.src;
      }
      const productImage: string = p.image?.src ?? p.images?.[0]?.src ?? '';

      for (const v of variantsArr) {
        // Image: variant-specific image, then product fallback, then '' (allowed — not required)
        const variantImage: string =
          (v.image_id && imageMap[String(v.image_id)])
            ? imageMap[String(v.image_id)]
            : productImage;

        const sku   = (v.sku ?? '').trim();
        const price = Number(v.price ?? 0);

        if (!sku) {
          this.logger.warn(`[SYNC SKIP] Product "${cleanTitle}" variant ${v.id} — missing SKU`);
          skippedMissingSku++;
          continue;
        }
        if (price <= 0) {
          this.logger.warn(`[SYNC SKIP] Product "${cleanTitle}" SKU "${sku}" — price=0 or missing`);
          skippedMissingPrice++;
          continue;
        }
        if (!variantImage) {
          this.logger.warn(`[SYNC WARN] Product "${cleanTitle}" SKU "${sku}" — no image (syncing with empty)`);
        }

        valid.push({
          shopifyProductId: String(p.id),
          variantId:        String(v.id),
          title:            cleanTitle,
          sku,
          price,
          image:            variantImage,
          inventoryItemId:  v.inventory_item_id ? String(v.inventory_item_id) : '',
          shopifyUpdatedAt: v.updated_at ? String(v.updated_at) : '',
        });
      }
    }

    return { valid, rawVariantCount, skippedInactive, skippedInvalid, skippedMissingSku, skippedMissingPrice };
  }

  // ── Daily auto-sync cron (2:30 AM IST = 21:00 UTC) ───────────────────────
  // Incremental — only fetches products changed in the last 25 hours to catch
  // any products that may have been missed during the previous day's run.
  @Cron('0 21 * * *')
  async scheduledSync() {
    if (syncStatus.status === 'running') {
      this.logger.warn('[AUTO-SYNC] Skipping — another sync is already running');
      return;
    }
    this.logger.log('[AUTO-SYNC] Starting scheduled daily incremental sync');
    const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await this.syncProducts({ mode: 'incremental', updatedSince: cutoff, trigger: 'auto' });
  }

  // ── Main sync — writes exclusively to shopify_catalog_items ──────────────
  async syncProducts(opts: { mode?: 'full' | 'incremental'; updatedSince?: string; trigger?: 'auto' | 'manual' } = {}): Promise<{
    fetched: number;         // raw Shopify products
    variants: number;        // valid variants after filtering
    inserted: number;
    changed: number;         // rows with actual field changes
    verified: number;        // rows processed but already current
    skipped: number;
    errors: number;
    durationMs: number;
    error?: string;
  }> {
    const syncType  = opts.mode ?? 'full';
    const trigger   = opts.trigger ?? 'manual';
    const startedAt = new Date().toISOString();
    const startMs   = Date.now();

    syncStatus = {
      total: 0, processed: 0, inserted: 0, changed: 0, verified: 0,
      skipped: 0, errors: 0,
      status: 'running', phase: 'fetching', lastError: '',
      lastSyncAt:           syncStatus.lastSyncAt,
      lastSuccessfulSyncAt: syncStatus.lastSuccessfulSyncAt,
      lastSyncType:         syncStatus.lastSyncType,
      startedAt,
      durationMs:           null,
      fetchedProducts:      0,
      rawVariants:          0,
      skippedSyncIgnored:   0,
      skippedMissingSku:    0,
      skippedMissingPrice:  0,
      skippedInactive:      0,
      skippedInvalid:       0,
      skippedDuplicateSku:  0,
      reconciled:           null,
      autoSync:             syncStatus.autoSync,
      manualSync:           syncStatus.manualSync,
    };

    let inserted = 0;
    let changed  = 0;
    let verified = 0;
    let skipped  = 0;
    let errors   = 0;

    try {
      const rawProducts = await this.getProducts(opts.updatedSince);
      this.logger.log(`[SYNC] Fetched ${rawProducts.length} active products from Shopify (${syncType})`);

      syncStatus.fetchedProducts = rawProducts.length;

      // flattenToVariants returns counts so every raw variant is accounted for
      const { valid: variants, rawVariantCount, skippedInactive, skippedInvalid, skippedMissingSku, skippedMissingPrice }
        = this.flattenToVariants(rawProducts);

      const preSaveSkipped = skippedInactive + skippedInvalid + skippedMissingSku + skippedMissingPrice;

      this.logger.log(`[SYNC] Raw variants: ${rawVariantCount} | Valid: ${variants.length} | Pre-save excluded: ${preSaveSkipped} (inactive=${skippedInactive} invalid=${skippedInvalid} noSku=${skippedMissingSku} noPrice=${skippedMissingPrice})`);

      syncStatus.rawVariants          = rawVariantCount;
      syncStatus.skippedInactive      = skippedInactive;
      syncStatus.skippedInvalid       = skippedInvalid;
      syncStatus.skippedMissingSku    = skippedMissingSku;
      syncStatus.skippedMissingPrice  = skippedMissingPrice;
      syncStatus.total                = variants.length;
      syncStatus.phase                = 'saving';

      // ── Save loop ──────────────────────────────────────────────────────────
      const seenSkus          = new Set<string>();
      let skippedSyncIgnored  = 0;
      let skippedDuplicateSku = 0;

      for (const v of variants) {
        try {
          // Duplicate SKU guard — skip 2nd+ occurrences to prevent accidental overwrite
          if (seenSkus.has(v.sku)) {
            this.logger.warn(`[SYNC:DUPLICATE] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId} — duplicate in this run, skipping to prevent overwrite`);
            skippedDuplicateSku++;
            syncStatus.skippedDuplicateSku = skippedDuplicateSku;
            syncStatus.skipped = preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
            continue;
          }
          seenSkus.add(v.sku);

          // Primary match: shopifyVariantId (stable across SKU/price edits)
          let existing = await this.catalogRepo.findOneBy({ shopifyVariantId: v.variantId });

          // Fallback: match by SKU for pre-migration records missing shopifyVariantId
          if (!existing) {
            existing = await this.catalogRepo.findOneBy({ sku: v.sku });
          }

          if (existing) {
            if (existing.syncIgnored) {
              this.logger.debug(`[SYNC:IGNORED] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId} id=${existing.id} — sync-ignored by ops`);
              skippedSyncIgnored++;
              syncStatus.skippedSyncIgnored = skippedSyncIgnored;
              syncStatus.skipped = preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
              continue;
            }

            // Detect whether any field actually changed to avoid phantom "changed" counts
            const incomingImage    = v.image || existing.image || '';
            const itemCodeBackfill = existing.itemCode === `SP_${v.variantId}`
              ? `SP_${v.shopifyProductId}_${v.variantId}` : existing.itemCode;

            const nameChanged     = existing.itemName !== v.title;
            const skuChanged      = existing.sku      !== v.sku;
            const priceChanged    = Number(existing.sellingPrice) !== v.price;
            const imageChanged    = !!v.image && existing.image !== v.image;
            const itemCodeChanged = itemCodeBackfill !== existing.itemCode;

            if (nameChanged || skuChanged || priceChanged || imageChanged || itemCodeChanged) {
              if (skuChanged) {
                this.logger.warn(`[SYNC WARNING] Shopify variant changed SKU: "${existing.sku}" → "${v.sku}" (variantId=${v.variantId} productId=${v.shopifyProductId})`);
              }
              await this.catalogRepo.update({ id: existing.id }, {
                itemName:               v.title,
                sku:                    v.sku,
                sellingPrice:           v.price,
                retailPrice:            v.price,
                image:                  incomingImage,
                shopifyProductId:       v.shopifyProductId,
                shopifyVariantId:       v.variantId,
                shopifyInventoryItemId: v.inventoryItemId || existing.shopifyInventoryItemId || '',
                shopifyUpdatedAt:       v.shopifyUpdatedAt ? new Date(v.shopifyUpdatedAt) : existing.shopifyUpdatedAt,
                ...(itemCodeChanged ? { itemCode: itemCodeBackfill } : {}),
              });
              changed++;
              this.logger.debug(`[SYNC:CHANGED] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId} id=${existing.id}`);
            } else {
              verified++;
              this.logger.debug(`[SYNC:VERIFIED] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId} id=${existing.id}`);
            }
          } else {
            await this.catalogRepo.save({
              itemCode:               `SP_${v.shopifyProductId}_${v.variantId}`,
              shopifyProductId:       v.shopifyProductId,
              shopifyVariantId:       v.variantId,
              shopifyInventoryItemId: v.inventoryItemId || '',
              shopifyUpdatedAt:       v.shopifyUpdatedAt ? new Date(v.shopifyUpdatedAt) : null,
              itemName:               v.title,
              sku:                    v.sku,
              sellingPrice:           v.price,
              retailPrice:            v.price,
              wholesalePrice:         0,
              image:                  v.image || '',
              unit:                   'Nos',
              hsnCode:                '',
              gst:                    0,
              costPrice:              0,
              syncIgnored:            false,
              source:                 'SHOPIFY',
            });
            inserted++;
            this.logger.debug(`[SYNC:ADDED] sku="${v.sku}" variantId=${v.variantId} productId=${v.shopifyProductId}`);
          }

          syncStatus.processed = inserted + changed;
          syncStatus.inserted  = inserted;
          syncStatus.changed   = changed;
          syncStatus.verified  = verified;
        } catch (itemErr: any) {
          errors++;
          syncStatus.errors = errors;
          this.logger.error(`[ERROR] sku="${v.sku}": ${itemErr.message}`);
        }
      }

      // ── Reconciliation check ──────────────────────────────────────────────
      const totalSkipped      = preSaveSkipped + skippedSyncIgnored + skippedDuplicateSku;
      const totalAccountedFor = inserted + changed + verified + totalSkipped + errors;
      const reconciled        = totalAccountedFor === rawVariantCount;
      syncStatus.reconciled   = reconciled;

      if (!reconciled) {
        this.logger.error(`[SYNC] ⚠ RECONCILIATION MISMATCH: ${rawVariantCount} raw ≠ ${totalAccountedFor} accounted (gap: ${rawVariantCount - totalAccountedFor})`);
      } else {
        this.logger.log(`[SYNC] Reconciliation: ${rawVariantCount} = ${inserted}+${changed}+${verified}+${totalSkipped}+${errors} ✓`);
      }

      const durationMs = Date.now() - startMs;
      const now        = new Date().toISOString();

      const record: SyncRecord = {
        completedAt:         now,
        inserted, changed, verified, errors,
        skippedSyncIgnored,
        skippedMissingSku,
        skippedMissingPrice,
        skippedInactive,
        skippedInvalid,
        skippedDuplicateSku,
        rawVariants:         rawVariantCount,
        fetchedProducts:     rawProducts.length,
        fetchedVariants:     variants.length,
        durationMs,
        error: errors > 0 ? `${errors} variant error${errors > 1 ? 's' : ''}` : null,
        reconciled,
      };

      syncStatus.status               = 'done';
      syncStatus.phase                = 'done';
      syncStatus.processed            = inserted + changed;
      syncStatus.inserted             = inserted;
      syncStatus.changed              = changed;
      syncStatus.verified             = verified;
      syncStatus.skippedSyncIgnored   = skippedSyncIgnored;
      syncStatus.skippedDuplicateSku  = skippedDuplicateSku;
      syncStatus.skipped              = totalSkipped;
      syncStatus.errors               = errors;
      syncStatus.durationMs           = durationMs;
      syncStatus.lastSyncAt           = now;
      syncStatus.lastSuccessfulSyncAt = now;
      syncStatus.lastSyncType         = syncType;
      if (trigger === 'auto') syncStatus.autoSync   = record;
      else                    syncStatus.manualSync = record;

      this.logger.log(`[SYNC] ✅ Complete (${syncType}/${trigger}): raw=${rawVariantCount} valid=${variants.length} inserted=${inserted} changed=${changed} verified=${verified} skipped=${totalSkipped} errors=${errors} reconciled=${reconciled} duration=${durationMs}ms`);

      return { fetched: rawProducts.length, variants: variants.length, inserted, changed, verified, skipped: totalSkipped, errors, durationMs };

    } catch (error: any) {
      const durationMs = Date.now() - startMs;
      const readable   = classifyError(error);
      this.logger.error(`[SYNC] ❌ Fatal: ${readable}`, error.stack);

      const failRecord: SyncRecord = {
        completedAt:         new Date().toISOString(),
        inserted: 0, changed: 0, verified: 0, errors: 1,
        skippedSyncIgnored: 0, skippedMissingSku: 0, skippedMissingPrice: 0,
        skippedInactive: 0, skippedInvalid: 0, skippedDuplicateSku: 0,
        rawVariants: 0, fetchedProducts: 0, fetchedVariants: 0,
        durationMs,
        error: readable,
        reconciled: false,
      };

      syncStatus.status       = 'done';
      syncStatus.phase        = 'done';
      syncStatus.lastError    = readable;
      syncStatus.durationMs   = durationMs;
      syncStatus.lastSyncAt   = new Date().toISOString();
      syncStatus.lastSyncType = syncType;
      // lastSuccessfulSyncAt intentionally NOT updated on fatal failure
      if (trigger === 'auto') syncStatus.autoSync   = failRecord;
      else                    syncStatus.manualSync = failRecord;

      return { fetched: 0, variants: 0, inserted: 0, changed: 0, verified: 0, skipped: 0, errors: 1, durationMs, error: readable };
    }
  }

  // ── Item lookup by SKU — exact match first, then ILIKE prefix fallback ───
  async getItemBySku(sku: string) {
    const needle = sku.trim();
    // Exact match (case-insensitive)
    let found = await this.catalogRepo.findOneBy({ sku: ILike(needle) });
    // Prefix fallback for partial SKUs (e.g. "WS-" matches "WS-001")
    if (!found) {
      found = await this.catalogRepo.findOne({
        where: { sku: ILike(`${needle}%`) },
        order: { sku: 'ASC' },
      });
    }
    if (!found) return null;
    return { sku: found.sku, itemName: found.itemName, price: Number(found.sellingPrice), image: found.image || null, gst: Number(found.gst) || 0 };
  }
}

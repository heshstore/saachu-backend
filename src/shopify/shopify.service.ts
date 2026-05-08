import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';

// Module-level progress object — reset on server restart only
let syncStatus = {
  total: 0,
  processed: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  status: 'idle' as 'idle' | 'running' | 'done',
  phase: 'idle' as 'idle' | 'fetching' | 'saving' | 'done',
  lastError: '',
};

export function getSyncStatus() {
  return { ...syncStatus };
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

  // ── Fetch all active products from Shopify (paginated) ──────────────────
  async getProducts(): Promise<any[]> {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!store || !token) {
      throw new Error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env');
    }

    this.logger.log(`[SYNC] Starting product fetch — store: ${store}`);

    const allProducts: any[] = [];
    let since_id: string | undefined;
    let page = 0;

    while (true) {
      page++;
      const url = since_id
        ? `https://${store}/admin/api/2023-10/products.json?limit=250&status=active&since_id=${since_id}`
        : `https://${store}/admin/api/2023-10/products.json?limit=250&status=active`;

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

  private flattenToVariants(products: any[]): Array<{
    shopifyProductId: string;
    variantId: string;
    title: string;
    sku: string;
    price: number;
    image: string;
  }> {
    return products.flatMap((p: any) => {
      // Defensive status check — API already requests status=active, but guard here too
      const status = (p.status ?? 'active').toLowerCase();
      if (status !== 'active') {
        this.logger.warn(`[SHOPIFY SYNC SKIPPED] Product: "${p.title}" | Reason: Inactive (status=${p.status})`);
        return [];
      }

      const cleanTitle = this.parseProductTitle((p.title ?? '').trim()).cleanTitle;
      if (!cleanTitle) {
        this.logger.warn(`[SHOPIFY SYNC SKIPPED] Product ID: ${p.id} | Reason: Missing title`);
        return [];
      }

      const imageMap: Record<string, string> = {};
      for (const img of p.images ?? []) {
        if (img.id && img.src) imageMap[String(img.id)] = img.src;
      }
      const productImage: string = p.image?.src ?? p.images?.[0]?.src ?? '';

      return (p.variants ?? []).flatMap((v: any) => {
        const variantImage: string =
          (v.image_id && imageMap[String(v.image_id)])
            ? imageMap[String(v.image_id)]
            : productImage;

        const sku   = (v.sku ?? '').trim();
        const price = Number(v.price ?? 0);

        if (!sku) {
          this.logger.warn(`[SHOPIFY SYNC SKIPPED] Product: "${cleanTitle}" | Reason: Missing SKU`);
          return [];
        }
        if (price <= 0) {
          this.logger.warn(`[SHOPIFY SYNC SKIPPED] Product: "${cleanTitle}" SKU: "${sku}" | Reason: Missing price`);
          return [];
        }
        if (!variantImage) {
          this.logger.warn(`[SHOPIFY SYNC SKIPPED] Product: "${cleanTitle}" SKU: "${sku}" | Reason: Missing image`);
          return [];
        }

        return [{
          shopifyProductId: String(p.id),
          variantId:        String(v.id),
          title:            cleanTitle,
          sku,
          price,
          image:            variantImage,
        }];
      });
    });
  }

  // ── Main sync — writes exclusively to shopify_catalog_items ──────────────
  async syncProducts(): Promise<{
    fetched: number;
    variants: number;
    inserted: number;
    updated: number;
    skipped: number;
    skippedReasons: Record<string, number>;
    errors: number;
    error?: string;
  }> {
    syncStatus = {
      total: 0, processed: 0, inserted: 0, updated: 0,
      skipped: 0, errors: 0, status: 'running', phase: 'fetching', lastError: '',
    };

    let inserted = 0;
    let updated  = 0;
    let skipped  = 0;
    let errors   = 0;

    try {
      const rawProducts = await this.getProducts();
      this.logger.log(`[SYNC] Fetched ${rawProducts.length} active products from Shopify`);

      // flattenToVariants already filters out: inactive, missing title/sku/price/image
      const variants = this.flattenToVariants(rawProducts);
      this.logger.log(`[SYNC] ${variants.length} valid variants after filtering`);

      syncStatus.total = variants.length;
      syncStatus.phase = 'saving';

      for (const v of variants) {
        try {
          // Primary match: shopifyVariantId (stable across SKU/price edits)
          let existing = await this.catalogRepo.findOneBy({ shopifyVariantId: v.variantId });

          // Fallback: match by SKU for pre-migration records missing shopifyVariantId
          if (!existing) {
            existing = await this.catalogRepo.findOneBy({ sku: v.sku });
          }

          if (existing) {
            if (existing.syncIgnored) {
              this.logger.log(`[SYNC] Skipping sync-ignored id=${existing.id} sku="${existing.sku}"`);
              skipped++;
              continue;
            }
            if (existing.sku !== v.sku) {
              this.logger.log(`[SYNC] SKU renamed: "${existing.sku}" → "${v.sku}"`);
            }
            await this.catalogRepo.update({ id: existing.id }, {
              itemName:         v.title,
              sku:              v.sku,
              sellingPrice:     v.price,
              retailPrice:      v.price,
              image:            v.image || existing.image || '',
              shopifyProductId: v.shopifyProductId,
              shopifyVariantId: v.variantId,
              // Backfill item_code to full format if it's still the old SP_<variantId> style
              ...(existing.itemCode === `SP_${v.variantId}`
                ? { itemCode: `SP_${v.shopifyProductId}_${v.variantId}` }
                : {}),
            });
            updated++;
            this.logger.debug(`[UPDATE] id=${existing.id} sku="${v.sku}"`);
          } else {
            await this.catalogRepo.save({
              itemCode:         `SP_${v.shopifyProductId}_${v.variantId}`,
              shopifyProductId: v.shopifyProductId,
              shopifyVariantId: v.variantId,
              itemName:         v.title,
              sku:              v.sku,
              sellingPrice:     v.price,
              retailPrice:      v.price,
              wholesalePrice:   0,
              image:            v.image || '',
              unit:             'Nos',
              hsnCode:          '',
              gst:              0,
              costPrice:        0,
              syncIgnored:      false,
              source:           'SHOPIFY',
            });
            inserted++;
            this.logger.debug(`[INSERT] sku="${v.sku}"`);
          }

          syncStatus.processed = inserted + updated;
          syncStatus.inserted  = inserted;
          syncStatus.updated   = updated;
          syncStatus.skipped   = skipped;
        } catch (itemErr: any) {
          errors++;
          syncStatus.errors = errors;
          this.logger.error(`[ERROR] sku="${v.sku}": ${itemErr.message}`);
        }
      }

      syncStatus.status    = 'done';
      syncStatus.phase     = 'done';
      syncStatus.processed = inserted + updated;
      syncStatus.inserted  = inserted;
      syncStatus.updated   = updated;
      syncStatus.skipped   = skipped;
      syncStatus.errors    = errors;

      this.logger.log(`[SYNC] ✅ Complete: fetched=${rawProducts.length} valid=${variants.length} inserted=${inserted} updated=${updated} skipped=${skipped} errors=${errors}`);

      return { fetched: rawProducts.length, variants: variants.length, inserted, updated, skipped, skippedReasons: {}, errors };

    } catch (error: any) {
      this.logger.error(`[SYNC] ❌ Fatal: ${error.message}`, error.stack);
      syncStatus.status    = 'done';
      syncStatus.phase     = 'done';
      syncStatus.lastError = error.message;
      return { fetched: 0, variants: 0, inserted: 0, updated: 0, skipped: 0, skippedReasons: {}, errors: 1, error: error.message };
    }
  }

  // ── Item lookup by SKU (fuzzy — used by order/fulfilment flows) ──────────
  async getItemBySku(sku: string) {
    const normalize = (s: any) => (s ?? '').toString().toLowerCase().replace(/\s+/g, '');
    const items = await this.catalogRepo.find();
    const found = items.find(
      i => normalize(i.sku) === normalize(sku) || normalize(i.sku).includes(normalize(sku)),
    );
    if (!found) return null;
    return { sku: found.sku, itemName: found.itemName, price: Number(found.sellingPrice), image: found.image || null, gst: Number(found.gst) || 0 };
  }
}

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShopifyCatalogItem } from './entities/shopify-catalog-item.entity';

export interface SyncVariantData {
  shopifyProductId: string;
  variantId: string;
  title: string;
  sku: string;
  price: number;
  image: string;
}

const ALLOWED_GST = [5, 18];

@Injectable()
export class ShopifyCatalogService {
  private readonly logger = new Logger(ShopifyCatalogService.name);

  constructor(
    @InjectRepository(ShopifyCatalogItem)
    private readonly repo: Repository<ShopifyCatalogItem>,
  ) {}

  isSalesReady(item: ShopifyCatalogItem): boolean {
    return !!(item.hsnCode && item.hsnCode.trim() !== '' && item.costPrice > 0);
  }

  findAll() {
    return this.repo.find({ order: { itemName: 'ASC' } });
  }

  findPending() {
    return this.repo
      .createQueryBuilder('s')
      .where("(s.hsn_code IS NULL OR s.hsn_code = '' OR s.cost_price <= 0)")
      .andWhere('s.sync_ignored = false')
      .orderBy('s.item_name', 'ASC')
      .getMany();
  }

  findReady() {
    return this.repo
      .createQueryBuilder('s')
      .where("s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0")
      .andWhere('s.sync_ignored = false')
      .orderBy('s.item_name', 'ASC')
      .getMany();
  }

  findIgnored() {
    return this.repo
      .createQueryBuilder('s')
      .where('s.sync_ignored = true')
      .orderBy('s.item_name', 'ASC')
      .getMany();
  }

  async getStats() {
    const [row] = await this.repo.manager.query<Record<string, string>[]>(`
      SELECT
        COUNT(*)                  FILTER (WHERE NOT sync_ignored)                                                                                                           AS total_variants,
        COUNT(DISTINCT item_name) FILTER (WHERE NOT sync_ignored)                                                                                                           AS total_items,
        COUNT(*)                  FILTER (WHERE NOT sync_ignored AND hsn_code IS NOT NULL AND hsn_code <> '' AND cost_price > 0)                                            AS quot_ready_variants,
        COUNT(DISTINCT item_name) FILTER (WHERE NOT sync_ignored AND hsn_code IS NOT NULL AND hsn_code <> '' AND cost_price > 0)                                            AS quot_ready_items,
        COUNT(*)                  FILTER (WHERE NOT sync_ignored AND hsn_code IS NOT NULL AND hsn_code <> '' AND cost_price > 0 AND main_category_type IS NOT NULL AND main_category_type <> '') AS boq_ready_variants,
        COUNT(DISTINCT item_name) FILTER (WHERE NOT sync_ignored AND hsn_code IS NOT NULL AND hsn_code <> '' AND cost_price > 0 AND main_category_type IS NOT NULL AND main_category_type <> '') AS boq_ready_items,
        COUNT(*)                  FILTER (WHERE sync_ignored)                                                                                                                AS hidden_variants,
        COUNT(*)                  FILTER (WHERE NOT sync_ignored AND wholesale_price > 0)                                                                                   AS wholesale_ready_variants,
        COUNT(DISTINCT item_name) FILTER (WHERE NOT sync_ignored AND wholesale_price > 0)                                                                                   AS wholesale_ready_items
      FROM shopify_catalog_items
    `);
    return {
      syncTotal:      { items: Number(row.total_items ?? 0),              variants: Number(row.total_variants ?? 0) },
      quotationReady: { items: Number(row.quot_ready_items ?? 0),         variants: Number(row.quot_ready_variants ?? 0) },
      boqReady:       { items: Number(row.boq_ready_items ?? 0),          variants: Number(row.boq_ready_variants ?? 0) },
      hiddenVariants: Number(row.hidden_variants ?? 0),
      wholesaleReady: { items: Number(row.wholesale_ready_items ?? 0),    variants: Number(row.wholesale_ready_variants ?? 0) },
    };
  }

  findById(id: number) {
    return this.repo.findOneBy({ id });
  }

  findBySku(sku: string) {
    return this.repo.findOneBy({ sku });
  }

  async configure(id: number, data: {
    hsnCode?: string; costPrice?: number; gst?: number;
    mainCategoryType?: string | null; serviceSubtype?: string | null;
  }) {
    if (data.gst !== undefined && data.gst !== null) {
      const n = Number(data.gst);
      if (n !== 0 && !ALLOWED_GST.includes(n)) {
        throw new BadRequestException(`Invalid GST rate ${data.gst}. Allowed values: ${ALLOWED_GST.join(', ')}%`);
      }
    }
    const update: Partial<ShopifyCatalogItem> = {};
    if (data.hsnCode          !== undefined) update.hsnCode          = data.hsnCode;
    if (data.costPrice        !== undefined) update.costPrice        = Number(data.costPrice) || 0;
    if (data.gst              !== undefined) update.gst              = Number(data.gst) || 0;
    if (data.mainCategoryType !== undefined) update.mainCategoryType = data.mainCategoryType || null;
    if (data.serviceSubtype   !== undefined) update.serviceSubtype   = data.serviceSubtype   || null;
    await this.repo.update(id, update);
    return this.repo.findOneBy({ id });
  }

  async ignoreSync(id: number) {
    await this.repo.update(id, { syncIgnored: true });
    return { message: 'Item hidden from catalog and excluded from future syncs' };
  }

  async restore(id: number) {
    await this.repo.update(id, { syncIgnored: false });
    return { message: 'Item restored' };
  }

  /** Bulk upsert called by Shopify sync — matches by shopifyVariantId */
  async upsertFromSync(variants: SyncVariantData[]): Promise<{ inserted: number; updated: number; skipped: number; errors: number }> {
    let inserted = 0, updated = 0, skipped = 0, errors = 0;

    for (const v of variants) {
      try {
        const existing = await this.repo.findOneBy({ shopifyVariantId: v.variantId });

        if (existing) {
          if (existing.syncIgnored) {
            this.logger.log(`[SYNC] Skipping sync-ignored item id=${existing.id} sku="${existing.sku}"`);
            skipped++;
            continue;
          }
          await this.repo.update({ id: existing.id }, {
            itemName:    v.title,
            sku:         v.sku,
            sellingPrice: v.price,
            retailPrice:  v.price,
            image:        v.image || existing.image || '',
            shopifyProductId: v.shopifyProductId,
          });
          updated++;
        } else {
          const itemCode = `SP_${v.shopifyProductId}_${v.variantId}`;
          await this.repo.save({
            itemCode,
            shopifyProductId: v.shopifyProductId,
            shopifyVariantId: v.variantId,
            itemName:    v.title,
            sku:         v.sku,
            sellingPrice: v.price,
            retailPrice:  v.price,
            wholesalePrice: 0,
            image:        v.image || '',
            unit:         'Nos',
            hsnCode:      '',
            gst:          0,
            costPrice:    0,
            syncIgnored:  false,
            source:       'SHOPIFY',
          });
          inserted++;
        }
      } catch (err: any) {
        errors++;
        this.logger.error(`[SYNC ERROR] sku="${v.sku}": ${err.message}`);
      }
    }

    return { inserted, updated, skipped, errors };
  }

  /** Called by ShopifyItems page bulk-configure flow */
  async bulkConfigure(items: Array<{
    sku: string; hsnCode: string; gst: number; costPrice: number;
    wholesalePrice?: number; unit?: string;
    mainCategoryType?: string | null; serviceSubtype?: string | null;
  }>) {
    const results = [];
    for (const item of items) {
      const existing = await this.repo.findOneBy({ sku: item.sku });
      if (!existing) continue;
      const update: Partial<ShopifyCatalogItem> = {
        hsnCode:        item.hsnCode,
        gst:            item.gst,
        costPrice:      item.costPrice,
        wholesalePrice: item.wholesalePrice ?? existing.wholesalePrice,
        unit:           item.unit ?? existing.unit,
      };
      if (item.mainCategoryType !== undefined) update.mainCategoryType = item.mainCategoryType || null;
      if (item.serviceSubtype   !== undefined) update.serviceSubtype   = item.serviceSubtype   || null;
      await this.repo.update({ id: existing.id }, update);
      results.push({ ...existing, ...item });
    }
    return results;
  }
}

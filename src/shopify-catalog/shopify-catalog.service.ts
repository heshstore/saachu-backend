import { Injectable, Logger } from '@nestjs/common';
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
    const [pending, ready, ignored] = await Promise.all([
      this.repo.createQueryBuilder('s')
        .where("(s.hsn_code IS NULL OR s.hsn_code = '' OR s.cost_price <= 0)")
        .andWhere('s.sync_ignored = false').getCount(),
      this.repo.createQueryBuilder('s')
        .where("s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0")
        .andWhere('s.sync_ignored = false').getCount(),
      this.repo.createQueryBuilder('s').where('s.sync_ignored = true').getCount(),
    ]);
    return { shopifyPending: pending, shopifyReady: ready, shopifyIgnored: ignored };
  }

  findById(id: number) {
    return this.repo.findOneBy({ id });
  }

  findBySku(sku: string) {
    return this.repo.findOneBy({ sku });
  }

  async configure(id: number, data: { hsnCode?: string; costPrice?: number; gst?: number }) {
    const update: Partial<ShopifyCatalogItem> = {};
    if (data.hsnCode !== undefined) update.hsnCode = data.hsnCode;
    if (data.costPrice !== undefined) update.costPrice = Number(data.costPrice) || 0;
    if (data.gst !== undefined) update.gst = Number(data.gst) || 0;
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
  }>) {
    const results = [];
    for (const item of items) {
      const existing = await this.repo.findOneBy({ sku: item.sku });
      if (!existing) continue;
      await this.repo.update({ id: existing.id }, {
        hsnCode:      item.hsnCode,
        gst:          item.gst,
        costPrice:    item.costPrice,
        wholesalePrice: item.wholesalePrice ?? existing.wholesalePrice,
        unit:         item.unit ?? existing.unit,
      });
      results.push({ ...existing, ...item });
    }
    return results;
  }
}

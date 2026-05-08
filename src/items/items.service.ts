import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';
import { ServiceItem } from '../service-items/entities/service-item.entity';

/** Normalised shape returned to quotation/order/invoice consumers */
export interface UnifiedItem {
  id: number;
  itemName: string;
  sku: string;
  hsnCode: string;
  gst: number;
  costPrice: number;
  sellingPrice: number;
  retail_price: number;
  wholesale_price: number;
  unit: string;
  image: string | null;
  source: string;
}

function fromShopify(s: ShopifyCatalogItem): UnifiedItem {
  return {
    id:            s.id,
    itemName:      s.itemName,
    sku:           s.sku,
    hsnCode:       s.hsnCode,
    gst:           s.gst,
    costPrice:     s.costPrice,
    sellingPrice:  s.sellingPrice,
    retail_price:  s.retailPrice,
    wholesale_price: s.wholesalePrice,
    unit:          s.unit,
    image:         s.image ?? null,
    source:        'SHOPIFY',
  };
}

function fromService(s: ServiceItem): UnifiedItem {
  return {
    id:            s.id,
    itemName:      s.itemName,
    sku:           s.sku,
    hsnCode:       s.hsnCode,
    gst:           s.gst,
    costPrice:     s.costPrice,
    sellingPrice:  s.sellingPrice,
    retail_price:  s.sellingPrice,
    wholesale_price: 0,
    unit:          s.unit,
    image:         null,
    source:        'MANUAL',
  };
}

@Injectable()
export class ItemsService {
  constructor(
    @InjectRepository(ShopifyCatalogItem)
    private readonly shopifyRepo: Repository<ShopifyCatalogItem>,
    @InjectRepository(ServiceItem)
    private readonly serviceRepo: Repository<ServiceItem>,
  ) {}

  /**
   * Used by QuotationService and OrderService to look up an item by SKU
   * when building line items. Checks service items first, then Shopify catalog.
   */
  async findBySku(sku: string): Promise<UnifiedItem | null> {
    const svcItem = await this.serviceRepo.findOneBy({ sku, isActive: true });
    if (svcItem) return fromService(svcItem);

    const shopItem = await this.shopifyRepo.findOneBy({ sku });
    if (shopItem) return fromShopify(shopItem);

    return null;
  }

  /**
   * Master list for quotation/order/invoice item dropdowns:
   * - ALL active service items (always selectable)
   * - ONLY sales-ready Shopify items (HSN + costPrice > 0, not ignored)
   */
  async findMaster(): Promise<UnifiedItem[]> {
    const [serviceItems, shopifyReady] = await Promise.all([
      this.serviceRepo.find({ where: { isActive: true }, order: { itemName: 'ASC' } }),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where("s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0")
        .andWhere('s.sync_ignored = false')
        .orderBy('s.item_name', 'ASC')
        .getMany(),
    ]);

    return [
      ...serviceItems.map(fromService),
      ...shopifyReady.map(fromShopify),
    ].sort((a, b) => (a.itemName ?? '').localeCompare(b.itemName ?? ''));
  }

  /**
   * Search used by universal search and document form type-ahead:
   * - service items always searchable
   * - Shopify items only if sales-ready
   */
  async searchItems(q: string): Promise<UnifiedItem[]> {
    if (!q) return [];
    const like = `%${q}%`;

    const [svcResults, shopResults] = await Promise.all([
      this.serviceRepo
        .createQueryBuilder('s')
        .where('(s.item_name ILIKE :q OR s.sku ILIKE :q)', { q: like })
        .andWhere('s.is_active = true')
        .orderBy('s.sku', 'ASC')
        .take(10)
        .getMany(),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where('(s.item_name ILIKE :q OR s.sku ILIKE :q)', { q: like })
        .andWhere("s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0")
        .andWhere('s.sync_ignored = false')
        .orderBy('s.sku', 'ASC')
        .take(10)
        .getMany(),
    ]);

    return [...svcResults.map(fromService), ...shopResults.map(fromShopify)]
      .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? ''))
      .slice(0, 15);
  }

  /** Stats for sidebar badge and admin dashboard */
  async getStats() {
    const [manual, pending, ready, ignored] = await Promise.all([
      this.serviceRepo.count({ where: { isActive: true } }),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where("(s.hsn_code IS NULL OR s.hsn_code = '' OR s.cost_price <= 0)")
        .andWhere('s.sync_ignored = false').getCount(),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where("s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0")
        .andWhere('s.sync_ignored = false').getCount(),
      this.shopifyRepo
        .createQueryBuilder('s').where('s.sync_ignored = true').getCount(),
    ]);
    return { manual, shopifyPending: pending, shopifyReady: ready, shopifyIgnored: ignored };
  }
}

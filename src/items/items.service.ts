import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';
import { ServiceItem } from '../service-items/entities/service-item.entity';
import { appConfig } from '../config/config';

/** Service items store photos as a relative /uploads/... path; Shopify photos
 * are already full CDN URLs. Normalise both to an absolute URL so every
 * downstream consumer (quotation/order templates, PDF generation) can just
 * use the value directly. */
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `${appConfig.publicAppUrl}${url}`;
}

// ── Module-level in-memory caches ─────────────────────────────────────────────
// Node modules are singletons — these Maps persist across requests.
interface CacheEntry<T> {
  data: T;
  ts: number;
}
const _skuCache = new Map<string, CacheEntry<any>>(); // key = sku
const _masterCache = new Map<string, CacheEntry<any[]>>(); // key = 'master'
const _searchCache = new Map<string, CacheEntry<any[]>>(); // key = normalised query
const _statsCache = new Map<string, CacheEntry<any>>(); // key = 'stats'

/** Called by ServiceItemsService and ShopifyCatalogService after every mutation. */
export function clearItemsCache(): void {
  _skuCache.clear();
  _masterCache.clear();
  _searchCache.clear();
  _statsCache.clear();
}

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
  /** Null for Shopify items until manually assigned in the catalog screen */
  mainCategoryType: string | null;
}

function fromShopify(s: ShopifyCatalogItem): UnifiedItem {
  return {
    id: s.id,
    itemName: s.itemName,
    sku: s.sku,
    hsnCode: s.hsnCode,
    gst: s.gst,
    costPrice: s.costPrice,
    sellingPrice: s.sellingPrice,
    retail_price: s.retailPrice,
    wholesale_price: s.wholesalePrice,
    unit: s.unit,
    image: s.image ?? null,
    source: 'SHOPIFY',
    mainCategoryType: s.mainCategoryType ?? null,
  };
}

function fromService(s: ServiceItem): UnifiedItem {
  return {
    id: s.id,
    itemName: s.itemName,
    sku: s.sku,
    hsnCode: s.hsnCode,
    gst: s.gst,
    costPrice: s.costPrice,
    sellingPrice: s.sellingPrice,
    retail_price: s.sellingPrice,
    wholesale_price: 0,
    unit: s.unit,
    image: resolveImageUrl(s.imageUrl),
    source: 'MANUAL',
    mainCategoryType: s.mainCategoryType || 'TRADING',
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
    const hit = _skuCache.get(sku);
    if (hit && Date.now() - hit.ts < 300_000) return hit.data;

    const svcItem = await this.serviceRepo.findOneBy({ sku, isActive: true });
    if (svcItem) {
      const r = fromService(svcItem);
      _skuCache.set(sku, { data: r, ts: Date.now() });
      return r;
    }

    const shopItem = await this.shopifyRepo.findOneBy({ sku });
    const r = shopItem ? fromShopify(shopItem) : null;
    _skuCache.set(sku, { data: r, ts: Date.now() });
    return r;
  }

  /**
   * Master list for quotation/order/invoice item dropdowns:
   * - ALL active service items (always selectable)
   * - ONLY sales-ready Shopify items (HSN + costPrice > 0, not ignored)
   */
  async findMaster(): Promise<UnifiedItem[]> {
    const hit = _masterCache.get('master');
    if (hit && Date.now() - hit.ts < 300_000) return hit.data;

    const [serviceItems, shopifyReady] = await Promise.all([
      this.serviceRepo.find({
        where: { isActive: true },
        order: { itemName: 'ASC' },
      }),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where(
          "s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0",
        )
        .andWhere('s.sync_ignored = false')
        .orderBy('s.item_name', 'ASC')
        .getMany(),
    ]);

    const result = [
      ...serviceItems.map(fromService),
      ...shopifyReady.map(fromShopify),
    ].sort((a, b) => (a.itemName ?? '').localeCompare(b.itemName ?? ''));
    _masterCache.set('master', { data: result, ts: Date.now() });
    return result;
  }

  /**
   * Search used by universal search and document form type-ahead:
   * - service items always searchable
   * - Shopify items only if sales-ready
   */
  async searchItems(q: string): Promise<UnifiedItem[]> {
    if (!q) return [];
    const key = q.toLowerCase().trim();
    const hit = _searchCache.get(key);
    if (hit && Date.now() - hit.ts < 30_000) return hit.data;

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
        .andWhere(
          "s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0",
        )
        .andWhere('s.sync_ignored = false')
        .orderBy('s.sku', 'ASC')
        .take(10)
        .getMany(),
    ]);

    const result = [
      ...svcResults.map(fromService),
      ...shopResults.map(fromShopify),
    ]
      .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? ''))
      .slice(0, 15);
    _searchCache.set(key, { data: result, ts: Date.now() });
    return result;
  }

  /** Stats for sidebar badge and admin dashboard */
  async getStats() {
    const hit = _statsCache.get('stats');
    if (hit && Date.now() - hit.ts < 120_000) return hit.data;

    const [manual, pending, ready, ignored] = await Promise.all([
      this.serviceRepo.count({ where: { isActive: true } }),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where("(s.hsn_code IS NULL OR s.hsn_code = '' OR s.cost_price <= 0)")
        .andWhere('s.sync_ignored = false')
        .getCount(),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where(
          "s.hsn_code IS NOT NULL AND s.hsn_code != '' AND s.cost_price > 0",
        )
        .andWhere('s.sync_ignored = false')
        .getCount(),
      this.shopifyRepo
        .createQueryBuilder('s')
        .where('s.sync_ignored = true')
        .getCount(),
    ]);
    const result = {
      manual,
      shopifyPending: pending,
      shopifyReady: ready,
      shopifyIgnored: ignored,
    };
    _statsCache.set('stats', { data: result, ts: Date.now() });
    return result;
  }
}

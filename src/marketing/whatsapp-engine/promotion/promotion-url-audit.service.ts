import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i;

export interface PromotionUrlAuditResult {
  /** Total active (non-ignored) catalog products. */
  totalProducts:        number;
  /** Products with a valid Shopify handle → correct /products/{handle} URL. */
  productsWithHandle:   number;
  /** Products where handle is null/empty. */
  missingHandles:       number;
  /** Handle values shared by more than one product. */
  duplicateHandles:     number;
  /** Products with no valid handle but a SKU → search fallback URL. */
  searchFallbackCount:  number;
  /** Products with neither handle nor SKU → cannot be linked safely. */
  rejectedCount:        number;
  /** (productsWithHandle / totalProducts) × 100, rounded. */
  coveragePct:          number;
  /** (rejectedCount / totalProducts) × 100 — products that must be skipped. */
  brokenPct:            number;
  /** (missingHandles / totalProducts) × 100 — will degrade to search fallback. */
  missingPct:           number;
  examples: {
    missingHandles:   { sku: string | null; itemName: string | null }[];
    duplicateHandles: { handle: string; count: number; skus: string[] }[];
    rejected:         { sku: string | null; itemName: string | null }[];
    searchFallback:   { sku: string | null; handle: string | null }[];
  };
}

@Injectable()
export class PromotionUrlAuditService {
  private readonly logger = new Logger(PromotionUrlAuditService.name);

  constructor(
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
  ) {}

  async runAudit(): Promise<PromotionUrlAuditResult> {
    const products = await this.catalogRepo
      .createQueryBuilder('c')
      .where('c.syncIgnored = false')
      .select(['c.id', 'c.sku', 'c.itemName', 'c.handle'])
      .getMany();

    const total = products.length;

    // ── Handle frequency map ──────────────────────────────────────────────────
    const handleMap = new Map<string, { count: number; skus: string[] }>();
    for (const p of products) {
      const h = p.handle?.trim() ?? '';
      if (!h) continue;
      const entry = handleMap.get(h) ?? { count: 0, skus: [] };
      entry.count++;
      if (p.sku) entry.skus.push(p.sku);
      handleMap.set(h, entry);
    }

    // ── Classify every product ────────────────────────────────────────────────
    const withHandle:    ShopifyCatalogItem[] = [];
    const missingHandle: ShopifyCatalogItem[] = [];
    const searchFallback: ShopifyCatalogItem[] = [];
    const rejected:      ShopifyCatalogItem[] = [];

    for (const p of products) {
      const h   = p.handle?.trim() ?? '';
      const sku = p.sku?.trim() ?? '';

      if (h && HANDLE_PATTERN.test(h)) {
        withHandle.push(p);
      } else if (sku) {
        searchFallback.push(p);
        if (!h) missingHandle.push(p);
      } else {
        rejected.push(p);
        if (!h) missingHandle.push(p);
      }
    }

    const dupHandles = [...handleMap.entries()]
      .filter(([, v]) => v.count > 1)
      .map(([handle, v]) => ({ handle, count: v.count, skus: v.skus }));

    const coveragePct = total ? Math.round((withHandle.length   / total) * 100) : 0;
    const brokenPct   = total ? Math.round((rejected.length     / total) * 100) : 0;
    const missingPct  = total ? Math.round((missingHandle.length / total) * 100) : 0;

    this.logger.log(
      `[PRODUCT_URL_AUDIT] total=${total} handle=${withHandle.length} (${coveragePct}%) ` +
      `search=${searchFallback.length} rejected=${rejected.length} (${brokenPct}%) ` +
      `missing_handle=${missingHandle.length} (${missingPct}%) dups=${dupHandles.length}`,
    );

    return {
      totalProducts:       total,
      productsWithHandle:  withHandle.length,
      missingHandles:      missingHandle.length,
      duplicateHandles:    dupHandles.length,
      searchFallbackCount: searchFallback.length,
      rejectedCount:       rejected.length,
      coveragePct,
      brokenPct,
      missingPct,
      examples: {
        missingHandles: missingHandle.slice(0, 10).map(p => ({
          sku:      p.sku      ?? null,
          itemName: p.itemName ?? null,
        })),
        duplicateHandles: dupHandles.slice(0, 10),
        rejected: rejected.slice(0, 10).map(p => ({
          sku:      p.sku      ?? null,
          itemName: p.itemName ?? null,
        })),
        searchFallback: searchFallback.slice(0, 10).map(p => ({
          sku:    p.sku    ?? null,
          handle: p.handle ?? null,
        })),
      },
    };
  }
}

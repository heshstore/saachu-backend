import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { PromotionProductRotation } from '../entities/promotion-product-rotation.entity';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';

const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PromotionProductSelectionService {
  private readonly logger = new Logger(PromotionProductSelectionService.name);

  constructor(
    @InjectRepository(PromotionProductRotation)
    private readonly rotationRepo: Repository<PromotionProductRotation>,
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
  ) {}

  /**
   * Returns a catalog product that this telecaller has NOT sent in the last 24h.
   * If every product has been sent, resets the window (so the telecaller can repeat from scratch).
   */
  async getEligibleProductForTelecaller(
    telecallerNumberId: string,
    options?: {
      category?: string;
      campaignId?: string;
      excludeSkus?: string[];
    },
  ): Promise<ShopifyCatalogItem | null> {
    const allProducts = await this._loadCatalog(options?.category);
    if (!allProducts.length) {
      this.logger.warn(
        `[PROMO_PRODUCT_SELECT] telecaller=${telecallerNumberId} no_catalog_products`,
      );
      return null;
    }

    const sentSkus = await this._getSentSkus(telecallerNumberId);
    const excludeSet = new Set(options?.excludeSkus ?? []);

    let eligible = allProducts.filter(
      (p) => !sentSkus.has(p.sku) && !excludeSet.has(p.sku ?? ''),
    );

    if (!eligible.length) {
      this.logger.log(
        `[PROMO_PRODUCT_SELECT] telecaller=${telecallerNumberId} all_exhausted=true — resetting rotation window`,
      );
      // Even on reset, still respect the same-run excludeSkus (already tried and rejected this run)
      eligible = allProducts.filter((p) => !excludeSet.has(p.sku ?? ''));
      if (!eligible.length) eligible = allProducts; // absolute last resort
    }

    const selected = eligible[Math.floor(Math.random() * eligible.length)];
    this.logger.log(
      `[PROMO_PRODUCT_SELECT] telecaller=${telecallerNumberId} ` +
        `total=${allProducts.length} sent_24h=${sentSkus.size} eligible=${eligible.length} ` +
        `selected_sku=${selected.sku} selected_id=${selected.id}`,
    );
    return selected;
  }

  /** Returns a specific catalog product by id, or null if not found / ignored. */
  async findById(productId: number): Promise<ShopifyCatalogItem | null> {
    return (
      this.catalogRepo.findOne({
        where: { id: productId, syncIgnored: false },
      }) ?? null
    );
  }

  /** Records that a telecaller sent this product; call after message is queued or sent. */
  async recordProductSent(
    telecallerNumberId: string,
    product: ShopifyCatalogItem,
    campaignId?: string,
  ): Promise<void> {
    await this.rotationRepo.save(
      this.rotationRepo.create({
        telecaller_number_id: telecallerNumberId,
        product_id: product.id,
        sku: product.sku ?? '',
        campaign_id: campaignId ?? null,
      }),
    );
  }

  private async _loadCatalog(category?: string): Promise<ShopifyCatalogItem[]> {
    const qb = this.catalogRepo
      .createQueryBuilder('c')
      .where('c.syncIgnored = false')
      .andWhere('c.sku IS NOT NULL');

    if (category) {
      qb.andWhere('c.mainCategoryType = :cat', { cat: category });
    }

    return qb.getMany();
  }

  private async _getSentSkus(telecallerNumberId: string): Promise<Set<string>> {
    const since = new Date(Date.now() - ROTATION_WINDOW_MS);
    const rows = await this.rotationRepo.find({
      where: {
        telecaller_number_id: telecallerNumberId,
        sent_at: MoreThanOrEqual(since),
      },
      select: ['sku'],
    });
    return new Set(rows.map((r) => r.sku));
  }
}

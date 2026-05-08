import { Controller, Get, Param, Logger } from '@nestjs/common';
import { ShopifyService, getSyncStatus } from './shopify.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('products')
  @RequirePermission('item.view')
  getProducts() {
    return this.shopifyService.getProducts();
  }

  @Get('sync-products')
  @RequirePermission('item.shopify_sync')
  async syncProducts() {
    this.logger.log('[SHOPIFY] Manual sync triggered via GET /shopify/sync-products');
    try {
      const result = await this.shopifyService.syncProducts();
      this.logger.log(
        `[SHOPIFY] Sync finished — fetched=${result.fetched} variants=${result.variants} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}`,
      );
      return result;
    } catch (error: any) {
      this.logger.error('[SHOPIFY] Controller-level error:', error?.message);
      return {
        fetched: 0, active: 0, variants: 0,
        inserted: 0, updated: 0, skipped: 0,
        skippedReasons: {}, errors: 1, error: error?.message ?? 'Sync failed',
      };
    }
  }

  @Get('sync')
  @RequirePermission('item.shopify_sync')
  syncProductsAlias() {
    return this.syncProducts();
  }

  @Get('sync-status')
  getStatus() {
    return getSyncStatus();
  }

  @Get(':sku')
  @RequirePermission('item.view')
  getItem(@Param('sku') sku: string) {
    return this.shopifyService.getItemBySku(sku);
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import { ShopifyService, getSyncStatus } from './shopify.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('products')
  @RequirePermission('item.view')
  getProducts() {
    return this.shopifyService.getProducts();
  }

  @Get('sync-products')
  @RequirePermission('item.shopify_sync')
  async syncProducts() {
    console.log("STEP5 API HIT");
    try {
      const result = await this.shopifyService.syncProducts();

      const count = Array.isArray(result)
        ? result.length
        : result?.count || 0;

      return {
        count,
        data: result || [],
      };
    } catch (error) {
      console.log("STEP10 ERROR:", error);
      console.error("❌ Shopify Sync Error:", error);

      return {
        count: 0,
        error: error.message || "Sync failed",
      };
    }
  }

  @Get('sync')
  @RequirePermission('item.shopify_sync')
  async syncProductsAlias() {
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
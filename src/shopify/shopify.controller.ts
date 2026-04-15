import { Controller, Get, Param } from '@nestjs/common';
import { ShopifyService, getSyncStatus } from './shopify.service';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('shopify')
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('products')
  getProducts() {
    return this.shopifyService.getProducts();
  }

  @Get('sync-products')   // ✅ ADD THIS
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

  @Get('sync')   // ✅ BACKWARD COMPATIBILITY ROUTE
  async syncProductsAlias() {
    return this.syncProducts();
  }

  @Get('sync-status')
  getStatus() {
    return getSyncStatus();
  }

  @Get(':sku')
  getItem(@Param('sku') sku: string) {
    return this.shopifyService.getItemBySku(sku);
  }
}
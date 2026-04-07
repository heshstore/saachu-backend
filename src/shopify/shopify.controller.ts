import { Controller, Get, Param } from '@nestjs/common';
import { ShopifyService } from './shopify.service';

@Controller('shopify')   // ✅ CHANGE THIS
export class ShopifyController {
  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('products')
  getProducts() {
    return this.shopifyService.getProducts();
  }

  @Get('sync-products')   // ✅ ADD THIS
  syncProducts() {
    return this.shopifyService.syncProducts();
  }

  @Get(':sku')
  getItem(@Param('sku') sku: string) {
  return this.shopifyService.getItemBySku(sku);
}
}
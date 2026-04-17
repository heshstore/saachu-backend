import { Controller, Get, Post, Body, Param, Delete, Query } from '@nestjs/common';
import { ItemsService } from './items.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Post()
  async create(@Body() data: any) {
    if (data && data.sku) {
      await this.itemsService.removeBySku(data.sku);
    }
    return this.itemsService.create(data);
  }

  @Post('bulk')
  createBulk(@Body() data: any[]) {
    return this.itemsService.createBulk(data);
  }

  /**
   * GET /items          → all items (used by ShopifyItems page)
   * GET /items?master=1 → only items with HSN + costPrice filled
   *                       (used by QuotationForm, OrderForm, Invoice)
   */
  @Get()
  findAll(@Query('master') master?: string) {
    return master === '1'
      ? this.itemsService.findMaster()
      : this.itemsService.findAll();
  }

  /**
   * Search only within master-ready items so incomplete Shopify items
   * never appear as options when building a quotation/order.
   */
  @Get('search')
  async searchItems(@Query('q') q: string) {
    return this.itemsService.searchItems(q);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.itemsService.findOne(+id);
  }

  // NOTE: PUT is not used by frontend; POST is always used to "update" (replace)
  // PATCH and PUT not exposed to enforce strict INSERT/DELETE-then-POST

  @Delete(':sku')
  removeBySku(@Param('sku') sku: string) {
    return this.itemsService.removeBySku(sku);
  }
}
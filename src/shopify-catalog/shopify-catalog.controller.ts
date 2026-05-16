import { Controller, Get, Patch, Post, Body, Param } from '@nestjs/common';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('shopify-catalog')
export class ShopifyCatalogController {
  constructor(private readonly svc: ShopifyCatalogService) {}

  @Get()
  @RequirePermission('item.view')
  findAll() {
    return this.svc.findAll();
  }

  @Get('stats')
  @RequirePermission('item.view')
  getStats() {
    return this.svc.getStats();
  }

  @Get('pending')
  @RequirePermission('item.view')
  findPending() {
    return this.svc.findPending();
  }

  @Get('ready')
  @RequirePermission('item.view')
  findReady() {
    return this.svc.findReady();
  }

  @Get('hidden')
  @RequirePermission('item.view')
  findIgnored() {
    return this.svc.findIgnored();
  }

  @Get(':id')
  @RequirePermission('item.view')
  findById(@Param('id') id: string) {
    return this.svc.findById(+id);
  }

  @Patch(':id/configure')
  @RequirePermission('item.edit')
  configure(@Param('id') id: string, @Body() data: any) {
    return this.svc.configure(+id, data);
  }

  @Patch(':id/ignore')
  @RequirePermission('item.edit')
  ignoreSync(@Param('id') id: string) {
    return this.svc.ignoreSync(+id);
  }

  @Patch(':id/restore')
  @RequirePermission('item.edit')
  restore(@Param('id') id: string) {
    return this.svc.restore(+id);
  }

  /** Bulk configure — called by ShopifyItems page save flow */
  @Post('bulk-configure')
  @RequirePermission('item.edit')
  bulkConfigure(@Body() items: any[]) {
    return this.svc.bulkConfigure(items);
  }
}

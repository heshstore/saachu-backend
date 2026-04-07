import { Controller, Get, Post, Body, Param, Delete, Query } from '@nestjs/common';
import { ItemsService } from './items.service';

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Post()
  async create(@Body() data: any) {
    // 🚀 STRICT MODE PATCH — DELETE OLD THEN INSERT
    if (data && data.sku) {
      await this.itemsService.removeBySku(data.sku);
    }
    return this.itemsService.create(data);
  }

  @Post('bulk')
  createBulk(@Body() data: any[]) {
    return this.itemsService.createBulk(data);
  }

  @Get()
  findAll() {
    return this.itemsService.findAll();
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

  @Get('search')
  async searchItems(@Query('q') q: string) {
    return this.itemsService.searchItems(q);
  }
}
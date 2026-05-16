import { Controller, Get, Query } from '@nestjs/common';
import { ItemsService } from './items.service';
import { RequirePermission } from '../auth/require-permission.decorator';

/**
 * Unified facade used by:
 *   - DocumentForm  → GET /items?master=1
 *   - UniversalSearch → GET /items/search?q=
 *   - Dashboard / Sidebar → GET /items/stats
 *
 * All CRUD is now on /service-items and /shopify-catalog.
 */
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  /**
   * GET /items?master=1  → unified master list (quotation/order/invoice dropdowns)
   * GET /items           → alias for master list
   */
  @Get()
  @RequirePermission('item.view')
  findMaster(@Query('master') master?: string) {
    return this.itemsService.findMaster();
  }

  @Get('search')
  @RequirePermission('item.view')
  searchItems(@Query('q') q: string) {
    return this.itemsService.searchItems(q);
  }

  @Get('stats')
  @RequirePermission('item.view')
  getStats() {
    return this.itemsService.getStats();
  }
}

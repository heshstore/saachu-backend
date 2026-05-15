import {
  Controller, Get, Patch, Post, Body, Param, Query,
} from '@nestjs/common';
import { PurchaseRequirementsService } from './purchase-requirements.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('purchase-requirements')
export class PurchaseRequirementsController {
  constructor(private readonly svc: PurchaseRequirementsService) {}

  @Get()
  @RequirePermission('inventory.view')
  findAll(
    @Query('status')    status?:    string,
    @Query('priority')  priority?:  string,
    @Query('itemId')    itemId?:    string,
    @Query('sourceId')  sourceId?:  string,
  ) {
    return this.svc.findAll({
      status,
      priority,
      itemId:   itemId   ? +itemId   : undefined,
      sourceId: sourceId ? +sourceId : undefined,
    });
  }

  @Get('stats')
  @RequirePermission('inventory.view')
  getStats() {
    return this.svc.getSummaryStats();
  }

  @Get(':id')
  @RequirePermission('inventory.view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(+id);
  }

  @Patch(':id')
  @RequirePermission('inventory.manage')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.update(+id, {
      status:   body.status,
      priority: body.priority,
      notes:    body.notes,
    });
  }

  @Post('regenerate/:orderId')
  @RequirePermission('inventory.manage')
  regenerate(@Param('orderId') orderId: string) {
    return this.svc.regenerateForOrder(+orderId);
  }
}

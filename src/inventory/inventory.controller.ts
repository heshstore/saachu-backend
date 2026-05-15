import {
  Controller, Get, Post, Patch, Body, Param, Query, Req,
} from '@nestjs/common';
import { Request } from 'express';
import { InventoryService } from './inventory.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  // ── Warehouse endpoints ───────────────────────────────────────────────────────

  @Get('warehouses')
  @RequirePermission('inventory.view')
  getWarehouses(@Query('includeInactive') inc?: string) {
    return this.svc.findAllWarehouses(inc === 'true');
  }

  @Post('warehouses')
  @RequirePermission('inventory.manage')
  createWarehouse(@Body() body: any) {
    return this.svc.createWarehouse(body);
  }

  @Patch('warehouses/:id')
  @RequirePermission('inventory.manage')
  updateWarehouse(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateWarehouse(+id, body);
  }

  // ── Inventory summary ─────────────────────────────────────────────────────────

  @Get('summary')
  @RequirePermission('inventory.view')
  getSummary() {
    return this.svc.getSummary();
  }

  // ── Item ledger ───────────────────────────────────────────────────────────────

  @Get('item/:itemId')
  @RequirePermission('inventory.view')
  getItemLedger(@Param('itemId') itemId: string) {
    return this.svc.getItemLedger(+itemId);
  }

  // ── Transaction entry ─────────────────────────────────────────────────────────

  @Post('transaction')
  @RequirePermission('inventory.manage')
  createTransaction(@Body() body: any, @Req() req: Request) {
    return this.svc.createTransaction(body, (req as any).user?.id);
  }

  // ── Transactions list ─────────────────────────────────────────────────────────

  @Get('transactions')
  @RequirePermission('inventory.view')
  getTransactions(
    @Query('limit')  limit  = '100',
    @Query('offset') offset = '0',
  ) {
    return this.svc.getTransactions(+limit, +offset);
  }
}

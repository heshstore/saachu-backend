import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PurchaseOrdersService } from './purchase-orders.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly svc: PurchaseOrdersService) {}

  @Post('from-requirements')
  @RequirePermission('inventory.manage')
  createFromRequirements(@Body() body: any, @Req() req: Request) {
    return this.svc.createFromRequirements({
      vendorId: Number(body.vendorId),
      purchaseRequirementIds: Array.isArray(body.purchaseRequirementIds)
        ? body.purchaseRequirementIds.map(Number)
        : [],
      warehouseId: body.warehouseId != null ? Number(body.warehouseId) : null,
      expectedDate: body.expectedDate ?? null,
      notes: body.notes ?? null,
      status: body.status,
      createdBy: (req as any).user?.id ?? null,
    });
  }

  @Post(':id/receive')
  @RequirePermission('inventory.manage')
  receive(
    @Param('id') id: string,
    @Body()
    body: {
      warehouseId?: number;
      lines: {
        purchaseOrderItemId: number;
        qty: number;
        warehouseId?: number;
      }[];
    },
    @Req() req: Request,
  ) {
    return this.svc.receive(+id, body, (req as any).user?.id);
  }

  @Get()
  @RequirePermission('inventory.view')
  findAll(
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
  ) {
    return this.svc.findAll({
      status,
      vendorId: vendorId ? +vendorId : undefined,
    });
  }

  @Get(':id')
  @RequirePermission('inventory.view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(+id);
  }

  @Patch(':id')
  @RequirePermission('inventory.manage')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateHeader(+id, body);
  }
}

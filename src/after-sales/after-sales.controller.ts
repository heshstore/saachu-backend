import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AfterSalesService } from './after-sales.service';

@Controller('after-sales')
export class AfterSalesController {
  constructor(private readonly svc: AfterSalesService) {}

  @Get('warehouses')
  @RequirePermission('customer.view')
  listWarehouses() {
    return this.svc.listWarehousesForService();
  }

  @Get('dashboard')
  @RequirePermission('customer.view')
  dashboard() {
    return this.svc.getDashboard();
  }

  @Get('customers/:customerId/lifecycle')
  @RequirePermission('customer.view')
  customerLifecycle(@Param('customerId', ParseIntPipe) customerId: number) {
    return this.svc.getCustomerLifecycle(customerId);
  }

  @Get('tickets')
  @RequirePermission('customer.view')
  listTickets(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listTickets({
      status,
      customerId: customerId ? +customerId : undefined,
      assignedTo: assignedTo ? +assignedTo : undefined,
      limit: limit ? +limit : undefined,
    });
  }

  @Get('tickets/:id')
  @RequirePermission('customer.view')
  getTicket(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getTicket(id);
  }

  @Post('tickets')
  @RequirePermission('customer.edit')
  createTicket(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this.svc.createTicket(body as any, (req as any).user?.id);
  }

  @Patch('tickets/:id')
  @RequirePermission('customer.edit')
  patchTicket(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    return this.svc.patchTicket(id, body as any, (req as any).user?.id);
  }

  @Post('tickets/:id/updates')
  @RequirePermission('customer.edit')
  addUpdate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    return this.svc.addTicketUpdate(id, body as any, (req as any).user?.id);
  }

  @Post('tickets/:id/spare-use')
  @RequirePermission('customer.edit')
  spareUse(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    return this.svc.consumeSpare(id, body as any, (req as any).user?.id);
  }

  @Get('amc')
  @RequirePermission('customer.view')
  listAmc(@Query('customerId') customerId?: string) {
    return this.svc.listAmc(customerId ? +customerId : undefined);
  }

  @Post('amc')
  @RequirePermission('customer.edit')
  createAmc(@Body() body: Record<string, unknown>) {
    return this.svc.createAmc(body as any);
  }

  @Patch('amc/:id')
  @RequirePermission('customer.edit')
  patchAmc(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.patchAmc(id, body as any);
  }

  @Get('technicians')
  @RequirePermission('staff.view')
  listTechnicians() {
    return this.svc.listTechnicians();
  }

  @Post('technicians')
  @RequirePermission('staff.edit')
  upsertTechnician(@Body() body: Record<string, unknown>) {
    return this.svc.upsertTechnician(body as any);
  }

  @Delete('technicians/:userId')
  @RequirePermission('staff.edit')
  deactivateTechnician(@Param('userId', ParseIntPipe) userId: number) {
    return this.svc.deactivateTechnician(userId);
  }
}

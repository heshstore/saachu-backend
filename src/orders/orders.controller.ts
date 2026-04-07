import { Controller, Post, Body, Get, Patch, Param, Put } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ✅ CREATE ORDER
  @Post()
  create(@Body() body: any) {
    return this.ordersService.create(body);
  }

  // ✅ GET ALL ORDERS
  @Get()
  findAll() {
    return this.ordersService.findAll();
  }

  // 🚀 STRICT MODE PATCH: GET PENDING APPROVAL ORDERS
  @Get('pending')
  findPending() {
    return this.ordersService.findPending();
  }

  // ✅ ADD PAYMENT
  @Post(':id/payment')
  addPayment(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.addPayment(+id, body);
  }

  // ✅ APPROVE ORDER
  @Patch(':id/approve')
  approve(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.approveOrder(+id, body);
  }

  // ✅ CANCEL ORDER
  @Patch(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.ordersService.cancel(+id);
  }

  @Get(':id/split-invoice')
  getSplitInvoice(@Param('id') id: string) {
    return this.ordersService.splitInvoice(Number(id));
  }

  @Put(':id')
  updateOrder(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.updateOrder(Number(id), body);
  }

  // ================= CONVERT TO ORDER =================
  @Patch(':id/convert-to-order')
  convertToOrder(@Param('id') id: string) {
    return this.ordersService.convertToOrder(Number(id));
  }

  // ================= SEND FOR APPROVAL =================
  @Patch(':id/send-for-approval')
  sendForApproval(@Param('id') id: string) {
    return this.ordersService.sendForApproval(Number(id));
  }

  // ================= REJECT ORDER =================
  @Patch(':id/reject')
  rejectOrder(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.rejectOrder(
      Number(id),
      body?.reason || '',
      null
    );
  }

  // ================= SEND TO PRODUCTION =================
  @Patch(':id/send-to-production')
  sendToProduction(@Param('id') id: string) {
    return this.ordersService.sendToProduction(Number(id));
  }

}
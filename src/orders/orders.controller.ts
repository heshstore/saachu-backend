import { Controller, Post, Body, Get, Patch, Param, Put, Res, Req, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import { OrdersService } from './orders.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
  ) {}

  @Post()
  @RequirePermission('order.create')
  create(@Body() body: any, @Req() req: Request) {
    return this.ordersService.create(body, (req as any).user);
  }

  @Get()
  @RequirePermission('order.view')
  findAll(@Query() query: any, @Req() req: Request) {
    return this.ordersService.findAll(query, (req as any).user);
  }

  @Get('pending')
  @RequirePermission('order.view')
  findPending() {
    return this.ordersService.findPending();
  }

  @Post(':id/payment')
  @RequirePermission('payment.create')
  addPayment(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.addPayment(+id, body);
  }

  @Patch(':id/approve')
  @RequirePermission('order.approve')
  approve(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.approveOrder(+id, body);
  }

  @Patch(':id/cancel')
  @RequirePermission('order.cancel')
  cancel(@Param('id') id: string) {
    return this.ordersService.cancel(+id);
  }

  @Get(':id/split-invoice')
  @RequirePermission('invoice.create')
  getSplitInvoice(@Param('id') id: string) {
    return this.ordersService.splitInvoice(Number(id));
  }

  @Put(':id')
  @RequirePermission('order.edit')
  updateOrder(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.updateOrder(Number(id), body);
  }

  @Patch(':id/convert-to-order')
  @RequirePermission('quotation.convert')
  convertToOrder(@Param('id') id: string) {
    return this.ordersService.convertToOrder(Number(id));
  }

  @Patch(':id/send-for-approval')
  @RequirePermission('order.create')
  sendForApproval(@Param('id') id: string) {
    return this.ordersService.sendForApproval(Number(id));
  }

  @Patch(':id/reject')
  @RequirePermission('order.reject')
  rejectOrder(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.rejectOrder(
      Number(id),
      body?.reason || '',
      null
    );
  }

  @Patch(':id/send-to-production')
  @RequirePermission('production.update')
  sendToProduction(@Param('id') id: string) {
    return this.ordersService.sendToProduction(Number(id));
  }

  @Get(':id/pdf')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.ordersService.findOne(Number(id));
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.orderTemplate(data),
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="order-${id}.pdf"`,
    });
    res.send(buffer);
  }

  @Post(':id/email')
  async sendEmail(@Param('id') id: string, @Body() body: { to: string }) {
    const data = await this.ordersService.findOne(Number(id));
    const filePath = await this.pdfService.generateAndSave('order', Number(id), data);
    await this.mailService.sendDocument(
      body.to,
      `Order ${(data as any).order_number || id}`,
      filePath,
    );
    return { ok: true };
  }

}
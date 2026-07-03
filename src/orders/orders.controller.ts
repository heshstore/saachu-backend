import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Put,
  Param,
  Query,
  Req,
  Res,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OrdersService } from './orders.service';
import { PaymentService } from './payment.service';
import { OrderExplosionService } from './order-explosion.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { SendEmailDto } from '../shared/dto/send-email.dto';
import { appConfig } from '../config/config';
import { TransactionalEmailService } from '../email-transactional/transactional-email.service';
import {
  DocumentActionLogService,
  DocumentActionType,
} from '../shared/document-action-log.service';

@Controller('orders')
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly paymentService: PaymentService,
    private readonly explosionService: OrderExplosionService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
    private readonly transactionalEmailService: TransactionalEmailService,
    private readonly documentActionLogService: DocumentActionLogService,
  ) {}

  @Post(':id/track')
  @RequirePermission('order.view')
  async track(
    @Param('id') id: string,
    @Body() body: { action: DocumentActionType },
  ) {
    await this.documentActionLogService.record(
      'order',
      Number(id),
      body.action,
    );
    return { ok: true };
  }

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

  @Get(':id/material-requirements')
  @RequirePermission('order.view')
  getMaterialRequirements(@Param('id') id: string) {
    return this.explosionService.getRequirements(Number(id));
  }

  @Get(':id/workloads')
  @RequirePermission('order.view')
  getWorkloads(@Param('id') id: string) {
    return this.explosionService.getWorkloads(Number(id));
  }

  @Get(':id')
  @RequirePermission('order.view')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(Number(id));
  }

  @Put(':id')
  @RequirePermission('order.edit')
  updateOrder(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.updateOrder(Number(id), body);
  }

  @Patch(':id/approve')
  @RequirePermission('order.approve')
  approve(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    return this.ordersService.approveOrder(
      Number(id),
      body?.remarks,
      (req as any).user,
    );
  }

  @Patch(':id/reject')
  @RequirePermission('order.reject')
  reject(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    return this.ordersService.rejectOrder(
      Number(id),
      body?.remarks,
      (req as any).user,
    );
  }

  @Patch(':id/send-for-approval')
  @RequirePermission('order.create')
  sendForApproval(@Param('id') id: string, @Body() body: any) {
    return this.ordersService.sendForApproval(Number(id), body);
  }

  @Patch(':id/send-to-production')
  @RequirePermission('production.update')
  sendToProduction(@Param('id') id: string) {
    return this.ordersService.sendToProduction(Number(id));
  }

  @Patch(':id/complete')
  @RequirePermission('order.approve')
  complete(@Param('id') id: string) {
    return this.ordersService.complete(Number(id));
  }

  @Patch(':id/cancel')
  @RequirePermission('order.cancel')
  cancel(@Param('id') id: string) {
    return this.ordersService.cancel(Number(id));
  }

  @Post(':id/payment')
  @RequirePermission('payment.create')
  addPayment(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    const {
      amount,
      payment_mode,
      mode,
      payment_reference,
      reference_no,
      notes,
    } = body;
    return this.paymentService.addPayment(
      Number(id),
      {
        amount: Number(amount),
        payment_mode: (payment_mode ?? mode ?? 'cash').toLowerCase(),
        payment_reference: payment_reference ?? reference_no ?? undefined,
        notes: notes ?? undefined,
      },
      (req as any).user?.id,
    );
  }

  @Get(':id/split-invoice')
  @RequirePermission('invoice.create')
  splitInvoice(@Param('id') id: string) {
    return this.ordersService.splitInvoice(Number(id));
  }

  @Get(':id/pdf')
  @RequirePermission('order.view')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const numId = Number(id);
    const data = await this.ordersService.findOne(numId);

    if (!data) {
      res.status(404).json({ message: 'Order not found' });
      return;
    }

    const items = (data as any).items;
    if (!Array.isArray(items) || items.length === 0) {
      this.logger.warn(`[PDF] Order ${numId} has no items`);
      throw new BadRequestException(
        'Order has no items — add items before generating a PDF',
      );
    }

    const orderNo =
      (data as any).order_no || (data as any).order_number || `ORD-${numId}`;
    this.logger.log(`[PDF] Generating PDF for order ${numId} (${orderNo})`);

    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.orderTemplate(data),
    );
    await this.documentActionLogService.record('order', numId, 'pdf');
    const filename = orderNo.replace(/\//g, '-') + '.pdf';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  @Post(':id/email')
  @RequirePermission('order.view')
  async sendEmail(
    @Param('id') id: string,
    @Body() body: SendEmailDto & { publicUrl?: string },
  ) {
    const data = await this.ordersService.findOne(Number(id));
    await this.transactionalEmailService.sendOrderEmail(
      Number(id),
      body.to,
      data,
      { publicUrl: body.publicUrl },
    );
    return { ok: true };
  }
}

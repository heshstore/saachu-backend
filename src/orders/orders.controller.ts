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

@Controller('orders')
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly paymentService: PaymentService,
    private readonly explosionService: OrderExplosionService,
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
    return this.ordersService.approveOrder(Number(id), body?.remarks, (req as any).user);
  }

  @Patch(':id/reject')
  @RequirePermission('order.reject')
  reject(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    return this.ordersService.rejectOrder(Number(id), body?.remarks, (req as any).user);
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
    const { amount, payment_mode, mode, payment_reference, reference_no, notes } = body;
    return this.paymentService.addPayment(Number(id), {
      amount:             Number(amount),
      payment_mode:       (payment_mode ?? mode ?? 'cash').toLowerCase(),
      payment_reference:  payment_reference ?? reference_no ?? undefined,
      notes:              notes ?? undefined,
    }, (req as any).user?.id);
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
    const data  = await this.ordersService.findOne(numId);

    if (!data) {
      res.status(404).json({ message: 'Order not found' });
      return;
    }

    const items = (data as any).items;
    if (!Array.isArray(items) || items.length === 0) {
      this.logger.warn(`[PDF] Order ${numId} has no items`);
      throw new BadRequestException('Order has no items — add items before generating a PDF');
    }

    const orderNo = (data as any).order_no || (data as any).order_number || `ORD-${numId}`;
    this.logger.log(`[PDF] Generating PDF for order ${numId} (${orderNo})`);

    const buffer   = await this.pdfService.generateBuffer(this.pdfService.orderTemplate(data));
    const filename = orderNo.replace(/\//g, '-') + '.pdf';
    res.set({
      'Content-Type':        'application/pdf',
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
    const data     = await this.ordersService.findOne(Number(id));
    const filePath = await this.pdfService.generateAndSave('order', Number(id), data);
    const orderNo  = (data as any).order_no || (data as any).order_number || id;
    const custName = (data as any).customer_name || 'Customer';
    const amount   = `₹${Number((data as any).total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const dateStr  = new Date((data as any).created_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const status   = (data as any).status || '';
    const pdfLink  = body.publicUrl || '';
    const co       = appConfig.companyName;

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">

    <!-- Header -->
    <div style="background:#005fb8;color:#fff;padding:22px 28px;">
      <div style="font-size:18px;font-weight:700;">${co}</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px;">Order Confirmation</div>
    </div>

    <!-- Body -->
    <div style="padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;">Dear <strong>${custName}</strong>,</p>
      <p style="margin:0 0 20px;color:#475569;">Your order has been confirmed by <strong>${co}</strong>. Please find the order details below.</p>

      <!-- Summary card -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr>
            <td style="padding:4px 0;color:#64748b;width:140px;">Order No.</td>
            <td style="padding:4px 0;font-weight:700;color:#0f172a;">${orderNo}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#64748b;">Date</td>
            <td style="padding:4px 0;color:#0f172a;">${dateStr}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#64748b;">Amount</td>
            <td style="padding:4px 0;font-weight:700;font-size:16px;color:#005fb8;">${amount}</td>
          </tr>
          ${status ? `<tr>
            <td style="padding:4px 0;color:#64748b;">Status</td>
            <td style="padding:4px 0;font-weight:600;color:#0f172a;">${status.replace(/_/g, ' ')}</td>
          </tr>` : ''}
        </table>
      </div>

      ${pdfLink ? `
      <!-- PDF link -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${pdfLink}" target="_blank"
           style="display:inline-block;background:#005fb8;color:#fff;text-decoration:none;padding:11px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          ⬇ View / Download PDF
        </a>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
          Or copy: <a href="${pdfLink}" style="color:#3b82f6;word-break:break-all;">${pdfLink}</a>
        </div>
      </div>
      ` : ''}

      <p style="margin:0;color:#475569;font-size:14px;">
        The order confirmation PDF is also attached to this email.
      </p>

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
      <p style="margin:0;font-size:14px;">Regards,<br><strong>${co}</strong></p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:12px 28px;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0;">
      This is an automated email. Please do not reply directly.
    </div>
  </div>
</body>
</html>`;

    const text = [
      `Dear ${custName},`,
      '',
      `Your order has been confirmed by ${co}.`,
      '',
      `Order No: ${orderNo}`,
      `Date: ${dateStr}`,
      `Amount: ${amount}`,
      status ? `Status: ${status.replace(/_/g, ' ')}` : '',
      pdfLink ? `\nDownload PDF:\n${pdfLink}` : '',
      '',
      `Regards,`,
      co,
    ].filter((l) => l !== null).join('\n');

    await this.mailService.sendHtml({
      to:      body.to,
      subject: `Order Confirmation ${orderNo} from ${co}`,
      html,
      text,
      pdfPath: filePath,
    });
    return { ok: true };
  }
}

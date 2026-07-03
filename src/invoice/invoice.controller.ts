import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import { Response } from 'express';
import { InvoiceService } from './invoice.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { TransactionalEmailService } from '../email-transactional/transactional-email.service';
import {
  DocumentActionLogService,
  DocumentActionType,
} from '../shared/document-action-log.service';

@Controller('invoice')
export class InvoiceController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
    private readonly transactionalEmailService: TransactionalEmailService,
    private readonly documentActionLogService: DocumentActionLogService,
  ) {}

  @Post(':id/track')
  @RequirePermission('invoice.view')
  async track(
    @Param('id') id: string,
    @Body() body: { action: DocumentActionType },
  ) {
    await this.documentActionLogService.record(
      'invoice',
      Number(id),
      body.action,
    );
    return { ok: true };
  }

  @Get('test')
  test() {
    return { message: 'Invoice route working' };
  }

  @Get()
  @RequirePermission('invoice.view')
  findAll() {
    return this.invoiceService.findAll();
  }

  @Get(':id')
  @RequirePermission('invoice.view')
  findOne(@Param('id') id: string) {
    return this.invoiceService.findOne(Number(id));
  }

  @Post('from-order/:id')
  @RequirePermission('invoice.create')
  createFromOrder(
    @Param('id') id: string,
    @Body() body: { type?: 'TALLY' | 'ESTIMATE' },
  ) {
    return this.invoiceService.createFromOrder(+id, body?.type ?? 'TALLY');
  }

  @Get(':id/pdf')
  @RequirePermission('invoice.view')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.invoiceService.findOne(Number(id));
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.invoiceTemplate(data),
    );
    await this.documentActionLogService.record('invoice', Number(id), 'pdf');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice-${id}.pdf"`,
    });
    res.send(buffer);
  }

  @Post(':id/email')
  @RequirePermission('invoice.view')
  async sendEmail(@Param('id') id: string, @Body() body: { to: string }) {
    const data = await this.invoiceService.findOne(Number(id));
    await this.transactionalEmailService.sendInvoiceEmail(
      Number(id),
      body.to,
      data,
    );
    return { ok: true };
  }

  // ── Split billing endpoints ──────────────────────────────────────────────────
  // New routes appended below. Existing routes above are completely untouched.

  @Get('split/order/:orderId')
  @RequirePermission('invoice.view')
  splitByOrder(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.invoiceService.findSplitByOrder(orderId);
  }

  @Post('split/:orderId/production')
  @RequirePermission('invoice.create')
  createProductionInvoice(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: { type?: 'TALLY' | 'ESTIMATE' },
  ) {
    return this.invoiceService.createSplitFromOrder(
      orderId,
      'PRODUCTION',
      body?.type ?? 'TALLY',
    );
  }

  @Post('split/:orderId/trading')
  @RequirePermission('invoice.create')
  createTradingInvoice(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: { type?: 'TALLY' | 'ESTIMATE' },
  ) {
    return this.invoiceService.createSplitFromOrder(
      orderId,
      'TRADING',
      body?.type ?? 'TALLY',
    );
  }

  @Post('split/:orderId/both')
  @RequirePermission('invoice.create')
  async createBothSplitInvoices(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: { type?: 'TALLY' | 'ESTIMATE' },
  ) {
    const type = body?.type ?? 'TALLY';
    const production = await this.invoiceService.createSplitFromOrder(
      orderId,
      'PRODUCTION',
      type,
    );
    const trading = await this.invoiceService.createSplitFromOrder(
      orderId,
      'TRADING',
      type,
    );
    return { production, trading };
  }
}

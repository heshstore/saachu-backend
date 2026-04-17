import { Controller, Get, Post, Param, Body, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { InvoiceService } from './invoice.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('invoice')
export class InvoiceController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
  ) {}

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
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.invoiceService.findOne(Number(id));
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.invoiceTemplate(data),
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice-${id}.pdf"`,
    });
    res.send(buffer);
  }

  @Post(':id/email')
  async sendEmail(@Param('id') id: string, @Body() body: { to: string }) {
    const data = await this.invoiceService.findOne(Number(id));
    const filePath = await this.pdfService.generateAndSave('invoice', Number(id), data);
    await this.mailService.sendDocument(
      body.to,
      `Invoice ${(data as any).invoice_no || id}`,
      filePath,
    );
    return { ok: true };
  }
}
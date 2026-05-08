import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { QuotationService } from './quotation.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { Public } from '../auth/public.decorator';
import { SendEmailDto } from '../shared/dto/send-email.dto';
import { appConfig } from '../config/config';

@Controller('quotations')
export class QuotationController {
  constructor(
    private readonly quotationService: QuotationService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
  ) {}

  @Post()
  @RequirePermission('quotation.create')
  create(@Body() body: any, @Request() req: any) {
    return this.quotationService.create(body, req.user);
  }

  @Get()
  @RequirePermission('quotation.view')
  findAll(@Query() query: any, @Request() req: any) {
    return this.quotationService.findAll(query, req.user);
  }

  @Get(':id')
  @RequirePermission('quotation.view')
  findOne(@Param('id') id: string) {
    return this.quotationService.findOne(Number(id));
  }

  @Put(':id')
  @RequirePermission('quotation.edit')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.quotationService.update(Number(id), body, req.user);
  }

  @Patch(':id/send')
  @RequirePermission('quotation.edit')
  send(@Param('id') id: string) {
    return this.quotationService.send(Number(id));
  }

  @Patch(':id/approve')
  @RequirePermission('quotation.edit')
  approve(@Param('id') id: string) {
    return this.quotationService.approve(Number(id));
  }

  @Patch(':id/reject')
  @RequirePermission('quotation.edit')
  reject(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.reject(Number(id), req.user);
  }

  @Patch(':id/cancel')
  @RequirePermission('quotation.cancel')
  cancel(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.cancel(Number(id), req.user);
  }

  @Delete(':id')
  @RequirePermission('quotation.delete')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.softDelete(Number(id), req.user);
  }

  @Post(':id/convert-to-order')
  @RequirePermission('quotation.convert')
  convertToOrder(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.convertToOrder(Number(id), req.user);
  }

  @Get(':id/pdf')
  @RequirePermission('quotation.view')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.quotationService.findOne(Number(id));
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.quotationTemplate(data),
    );
    const filename = ((data as any).quotation_no || `QUO-${id}`).replace(/\//g, '-') + '.pdf';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  @Get('public/:quotation_no/pdf')
  @Public()
  async getPublicPdf(@Param('quotation_no') quotation_no: string, @Res() res: Response) {
    const data = await this.quotationService.findByNo(quotation_no);
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.quotationTemplate(data),
    );
    const filename = quotation_no.replace(/\//g, '-') + '.pdf';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=300',
    });
    res.send(buffer);
  }

  @Post(':id/email')
  @RequirePermission('quotation.view')
  async sendEmail(
    @Param('id') id: string,
    @Body() body: SendEmailDto & { publicUrl?: string },
  ) {
    const data     = await this.quotationService.findOne(Number(id));
    const filePath = await this.pdfService.generateAndSave('quotation', Number(id), data);
    const qNo      = (data as any).quotation_no || id;
    const amount   = Number((data as any).total_amount || 0).toLocaleString('en-IN');
    const pdfLink  = body.publicUrl || '';

    const emailBody = [
      `Dear ${(data as any).customer_name || 'Customer'},`,
      ``,
      `Please find attached your quotation.`,
      ``,
      `Quotation No: ${qNo}`,
      `Amount: ₹${amount}`,
      pdfLink ? `\nDownload PDF:\n${pdfLink}` : '',
      ``,
      `Regards,`,
      appConfig.companyName,
    ].join('\n');

    await this.mailService.sendDocumentWithBody(
      body.to,
      `Quotation - ${qNo}`,
      emailBody,
      filePath,
    );
    return { ok: true };
  }
}

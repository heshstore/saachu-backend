import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
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

  @Patch(':id/cancel')
  @RequirePermission('quotation.cancel')
  cancel(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.cancel(Number(id), req.user);
  }

  @Post(':id/convert-to-order')
  @RequirePermission('quotation.convert')
  convertToOrder(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.convertToOrder(Number(id), req.user);
  }

  @Get(':id/pdf')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.quotationService.findOne(Number(id));
    const buffer = await this.pdfService.generateBuffer(
      this.pdfService.quotationTemplate(data),
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="quotation-${id}.pdf"`,
    });
    res.send(buffer);
  }

  @Post(':id/email')
  async sendEmail(@Param('id') id: string, @Body() body: { to: string }) {
    const data = await this.quotationService.findOne(Number(id));
    const filePath = await this.pdfService.generateAndSave('quotation', Number(id), data);
    await this.mailService.sendDocument(
      body.to,
      `Quotation ${(data as any).quotation_no || id}`,
      filePath,
    );
    return { ok: true };
  }
}

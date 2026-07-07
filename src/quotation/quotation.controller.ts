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
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { QuotationService } from './quotation.service';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { Public } from '../auth/public.decorator';
import { SendEmailDto } from '../shared/dto/send-email.dto';
import { appConfig } from '../config/config';
import { TransactionalEmailService } from '../email-transactional/transactional-email.service';
import {
  DocumentActionLogService,
  DocumentActionType,
} from '../shared/document-action-log.service';

@Controller('quotations')
export class QuotationController {
  private readonly logger = new Logger(QuotationController.name);

  constructor(
    private readonly quotationService: QuotationService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
    private readonly transactionalEmailService: TransactionalEmailService,
    private readonly documentActionLogService: DocumentActionLogService,
  ) {}

  @Post(':id/track')
  @RequirePermission('quotation.view')
  async track(
    @Param('id') id: string,
    @Body() body: { action: DocumentActionType },
  ) {
    await this.documentActionLogService.record(
      'quotation',
      Number(id),
      body.action,
    );
    return { ok: true };
  }

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
  convertToOrder(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.quotationService.convertToOrder(Number(id), req.user, body);
  }

  @Get(':id/pdf')
  @RequirePermission('quotation.view')
  async getPdf(@Param('id') id: string, @Res() res: Response) {
    const numId = Number(id);
    const data = await this.quotationService.findOne(numId);

    if (!data) {
      res.status(404).json({ message: 'Quotation not found' });
      return;
    }

    const items = (data as any).items;
    if (!Array.isArray(items) || items.length === 0) {
      this.logger.warn(`[PDF] Quotation ${numId} has no items`);
      throw new BadRequestException(
        'Quotation has no items — add items before generating a PDF',
      );
    }

    this.logger.log(
      `[PDF] Generating PDF for quotation ${numId} (${(data as any).quotation_no})`,
    );

    const buffer = await this.pdfService.generateBuffer(
      await this.pdfService.quotationTemplate(data),
    );
    await this.documentActionLogService.record('quotation', numId, 'pdf');
    const filename =
      ((data as any).quotation_no || `Quo-${id}`).replace(/\//g, '-') + '.pdf';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }

  @Get('public/:quotation_no/pdf')
  @Public()
  async getPublicPdf(
    @Param('quotation_no') quotation_no: string,
    @Res() res: Response,
  ) {
    const data = await this.quotationService.findByNo(quotation_no);

    if (!data) {
      res.status(404).json({ message: 'Quotation not found' });
      return;
    }

    this.logger.log(`[PDF] Generating public PDF for ${quotation_no}`);

    const buffer = await this.pdfService.generateBuffer(
      await this.pdfService.quotationTemplate(data),
    );
    await this.documentActionLogService.record(
      'quotation',
      (data as any).id,
      'pdf',
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
    const data = await this.quotationService.findOne(Number(id));
    // Built server-side (not trusted from the client) so the link in the
    // email is always a publicly reachable host — the frontend may be
    // running against a localhost/LAN API URL that means nothing off-device.
    const publicUrl =
      appConfig.publicAppUrl && (data as any).quotation_no
        ? `${appConfig.publicAppUrl}/quotations/public/${encodeURIComponent((data as any).quotation_no)}/pdf`
        : body.publicUrl;
    await this.transactionalEmailService.sendQuotationEmail(
      Number(id),
      body.to,
      data,
      { publicUrl },
    );
    return { ok: true };
  }
}

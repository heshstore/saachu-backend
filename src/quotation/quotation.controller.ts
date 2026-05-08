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
    const custName = (data as any).customer_name || 'Customer';
    const amount   = `₹${Number((data as any).total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const dateStr  = new Date((data as any).created_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const pdfLink  = body.publicUrl || '';
    const co       = appConfig.companyName;

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">

    <!-- Header -->
    <div style="background:#1e3a8a;color:#fff;padding:22px 28px;">
      <div style="font-size:18px;font-weight:700;">${co}</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px;">Proforma Invoice</div>
    </div>

    <!-- Body -->
    <div style="padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;">Dear <strong>${custName}</strong>,</p>
      <p style="margin:0 0 20px;color:#475569;">Please find attached your quotation from <strong>${co}</strong>.</p>

      <!-- Summary card -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr>
            <td style="padding:4px 0;color:#64748b;width:120px;">Quotation No.</td>
            <td style="padding:4px 0;font-weight:700;color:#0f172a;">${qNo}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#64748b;">Date</td>
            <td style="padding:4px 0;color:#0f172a;">${dateStr}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#64748b;">Amount</td>
            <td style="padding:4px 0;font-weight:700;font-size:16px;color:#1e3a8a;">${amount}</td>
          </tr>
        </table>
      </div>

      ${pdfLink ? `
      <!-- PDF link -->
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${pdfLink}" target="_blank"
           style="display:inline-block;background:#1e3a8a;color:#fff;text-decoration:none;padding:11px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          ⬇ View / Download PDF
        </a>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px;">
          Or copy this link: <a href="${pdfLink}" style="color:#3b82f6;word-break:break-all;">${pdfLink}</a>
        </div>
      </div>
      ` : ''}

      <p style="margin:0;color:#475569;font-size:14px;">
        The PDF is also attached to this email for your convenience.
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
      `Please find attached your quotation from ${co}.`,
      '',
      `Quotation No: ${qNo}`,
      `Date: ${dateStr}`,
      `Amount: ${amount}`,
      pdfLink ? `\nDownload PDF:\n${pdfLink}` : '',
      '',
      `Regards,`,
      co,
    ].join('\n');

    await this.mailService.sendHtml({
      to:      body.to,
      subject: `Quotation ${qNo} from ${co}`,
      html,
      text,
      pdfPath: filePath,
    });
    return { ok: true };
  }
}

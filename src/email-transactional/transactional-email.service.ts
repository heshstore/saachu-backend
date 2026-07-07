import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { TransactionalEmailLog } from './entities/transactional-email-log.entity';
import { PdfService } from '../shared/pdf.service';
import { MailService } from '../shared/mail.service';
import { appConfig } from '../config/config';

const PROVIDER = 'smtp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

@Injectable()
export class TransactionalEmailService {
  private readonly logger = new Logger(TransactionalEmailService.name);

  // PdfService and MailService are provided by SharedModule (@Global) — injected automatically.
  constructor(
    @InjectRepository(TransactionalEmailLog)
    private readonly logRepo: Repository<TransactionalEmailLog>,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
  ) {}

  // ── Public send methods ───────────────────────────────────────────────────────
  // Controllers load entity data (as they always have), then delegate here.

  /** Delegates SMTP connectivity check to MailService.verifySmtp(). */
  verifySmtp(): Promise<{ ok: boolean; error?: string }> {
    return this.mailService.verifySmtp();
  }

  /** Resolves a filename inside backend/static/ to an absolute path, or null if missing. */
  private _resolveStaticImage(filename: string): string | null {
    const p = path.join(process.cwd(), 'static', filename);
    return fs.existsSync(p) ? p : null;
  }

  async sendQuotationEmail(
    id: number,
    to: string,
    data: any,
    opts?: { publicUrl?: string },
  ): Promise<TransactionalEmailLog> {
    this.logger.log(`[TX_ENDPOINT_HIT] type=quotation id=${id} to=${to}`);
    this._guardInputs(to);
    const qNo = data?.quotation_no || `Quo-${id}`;
    // Revision number = how many times this quotation has already been
    // successfully emailed — 1st send has no prefix, 2nd send is "Revised 1", etc.
    const priorSends = await this.logRepo.count({
      where: { entity_type: 'quotation', entity_id: id, status: 'sent' },
    });
    const subject = priorSends
      ? `Revised ${priorSends}: Quotation No: ${qNo} — Attached for your reference`
      : `Quotation No: ${qNo} — Attached for your reference`;
    const logoPath = this._resolveStaticImage('logo.png');

    return this._sendAndLog('quotation', id, to, subject, async () => {
      this.logger.log(`[TX_PDF_BEGIN] type=quotation id=${id}`);
      const filePath = await this.pdfService.generateAndSave(
        'quotation',
        id,
        data,
      );
      this.logger.log(
        `[TX_EMAIL_PDF_READY] type=quotation id=${id} path=${filePath}`,
      );
      this._assertAttachmentReady(filePath, 'quotation', id);

      this.logger.log(`[TX_SMTP_BEGIN] type=quotation id=${id} to=${to}`);
      await this.mailService.sendHtml({
        to,
        subject,
        html: this._quotationHtml(data, opts?.publicUrl ?? '', !!logoPath),
        text: this._quotationText(data, opts?.publicUrl ?? ''),
        pdfPath: filePath,
        inlineImages: logoPath ? [{ cid: 'hesh-logo', path: logoPath }] : [],
      });
    });
  }

  async sendOrderEmail(
    id: number,
    to: string,
    data: any,
    opts?: { publicUrl?: string },
  ): Promise<TransactionalEmailLog> {
    this.logger.log(`[TX_ENDPOINT_HIT] type=order id=${id} to=${to}`);
    this._guardInputs(to);
    const orderNo = data?.order_no || data?.order_number || `Ord-${id}`;
    const subject = `Order Confirmation ${orderNo} from ${appConfig.companyName}`;

    return this._sendAndLog('order', id, to, subject, async () => {
      this.logger.log(`[TX_PDF_BEGIN] type=order id=${id}`);
      const filePath = await this.pdfService.generateAndSave('order', id, data);
      this.logger.log(
        `[TX_EMAIL_PDF_READY] type=order id=${id} path=${filePath}`,
      );
      this._assertAttachmentReady(filePath, 'order', id);

      this.logger.log(`[TX_SMTP_BEGIN] type=order id=${id} to=${to}`);
      await this.mailService.sendHtml({
        to,
        subject,
        html: this._orderHtml(data, opts?.publicUrl ?? ''),
        text: this._orderText(data, opts?.publicUrl ?? ''),
        pdfPath: filePath,
      });
    });
  }

  async sendInvoiceEmail(
    id: number,
    to: string,
    data: any,
  ): Promise<TransactionalEmailLog> {
    this.logger.log(`[TX_ENDPOINT_HIT] type=invoice id=${id} to=${to}`);
    this._guardInputs(to);
    const invoiceNo = data?.invoice_no || `Hs-${id}`;
    const subject = `Invoice ${invoiceNo} from ${appConfig.companyName}`;

    return this._sendAndLog('invoice', id, to, subject, async () => {
      this.logger.log(`[TX_PDF_BEGIN] type=invoice id=${id}`);
      const filePath = await this.pdfService.generateAndSave(
        'invoice',
        id,
        data,
      );
      this.logger.log(
        `[TX_EMAIL_PDF_READY] type=invoice id=${id} path=${filePath}`,
      );
      this._assertAttachmentReady(filePath, 'invoice', id);

      this.logger.log(`[TX_SMTP_BEGIN] type=invoice id=${id} to=${to}`);
      await this.mailService.sendHtml({
        to,
        subject,
        html: this._invoiceHtml(data),
        text: this._invoiceText(data),
        pdfPath: filePath,
      });
    });
  }

  getLogs(
    entityType?: string,
    entityId?: number,
  ): Promise<TransactionalEmailLog[]> {
    const qb = this.logRepo
      .createQueryBuilder('l')
      .orderBy('l.created_at', 'DESC')
      .take(100);
    if (entityType) qb.andWhere('l.entity_type = :t', { t: entityType });
    if (entityId) qb.andWhere('l.entity_id   = :id', { id: entityId });
    return qb.getMany();
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _guardInputs(to: string): void {
    const trimmed = to?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('Recipient email is required');
    }
    if (!EMAIL_RE.test(trimmed)) {
      throw new BadRequestException(
        `Invalid recipient email address: ${trimmed}`,
      );
    }
  }

  private async _sendAndLog(
    entityType: string,
    entityId: number,
    to: string,
    subject: string,
    send: () => Promise<void>,
  ): Promise<TransactionalEmailLog> {
    this.logger.log(
      `[TX_EMAIL_START] type=${entityType} id=${entityId} to=${to}`,
    );

    let status: string = 'sent';
    let errorMessage: string | null = null;

    try {
      await send();
      this.logger.log(
        `[TX_EMAIL_SENT] type=${entityType} id=${entityId} to=${to}`,
      );
    } catch (err: any) {
      status = 'failed';
      errorMessage = this._classifyError(err);
      this.logger.error(
        `[TX_EMAIL_FAILED] type=${entityType} id=${entityId} to=${to} ` +
          `reason="${errorMessage}" raw="${String(err?.message ?? '').slice(0, 120)}"`,
      );
    }

    // Always write the log row — even on failure.
    this.logger.log(
      `[TX_DB_LOG_BEGIN] type=${entityType} id=${entityId} status=${status}`,
    );
    const log = await this.logRepo.save(
      this.logRepo.create({
        entity_type: entityType,
        entity_id: entityId,
        recipient_email: to,
        subject,
        status,
        provider: PROVIDER,
        error_message: errorMessage,
      }),
    );

    if (status === 'failed') {
      throw new InternalServerErrorException(errorMessage ?? 'Email failed');
    }
    this.logger.log(
      `[TX_SUCCESS] type=${entityType} id=${entityId} log_id=${log.id}`,
    );
    return log;
  }

  /**
   * Verifies the generated PDF file exists on disk and is non-empty before
   * passing it to nodemailer. Throws if missing so the error is caught by
   * _sendAndLog and written to the failure log rather than causing a silent send.
   */
  private _assertAttachmentReady(
    filePath: string,
    entityType: string,
    id: number,
  ): void {
    const fullPath = path.join(process.cwd(), filePath.replace(/^\//, ''));
    if (!fs.existsSync(fullPath)) {
      throw new Error(`PDF attachment missing after generation: ${fullPath}`);
    }
    const size = fs.statSync(fullPath).size;
    if (size === 0) {
      throw new Error(`PDF attachment is empty (0 bytes): ${fullPath}`);
    }
    this.logger.log(
      `[TX_ATTACHMENT_VERIFIED] type=${entityType} id=${id} size=${size}B`,
    );
  }

  /** Maps raw SMTP / PDF exceptions to user-facing messages. Never exposes credentials or stack. */
  private _classifyError(err: any): string {
    const msg = String(err?.message ?? '');
    if (msg.includes('SMTP not configured'))
      return 'Email temporarily unavailable — SMTP not configured';
    if (msg.includes('ECONNREFUSED'))
      return 'Email temporarily unavailable — cannot connect to mail server';
    if (msg.includes('ETIMEDOUT'))
      return 'Email temporarily unavailable — mail server timed out';
    if (msg.includes('ENOTFOUND'))
      return 'Email temporarily unavailable — mail server not found';
    if (msg.includes('Invalid login') || msg.includes('Authentication'))
      return 'Email temporarily unavailable — SMTP authentication failed';
    if (typeof err?.responseCode === 'number' && err.responseCode >= 500)
      return 'Email temporarily unavailable — mail server rejected the message';
    if (msg.toLowerCase().includes('pdf') || msg.includes('pdfmake'))
      return 'PDF generation failed — check document data and try again';
    return 'Email failed — please try again later';
  }

  // ── HTML template helpers ────────────────────────────────────────────────────

  /** Green card shown when salesman info is available on the entity. */
  private _salesmanBlock(data: any): string {
    const name = data?.salesman_name || data?.sales_person || '';
    const phone = data?.salesman_phone || '';
    const role = data?.salesman_role || '';
    if (!name) return '';
    return `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin:20px 0 0;">
        <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Your Sales Contact</div>
        <div style="font-size:14px;font-weight:600;color:#0f172a;">${name}${role ? ` <span style="font-weight:400;color:#64748b;">(${role})</span>` : ''}</div>
        ${phone ? `<div style="font-size:13px;color:#0f172a;margin-top:4px;">📞 ${phone}</div>` : ''}
      </div>`;
  }

  /** Row of circular, brand-coloured social icon links — omits any network without a configured URL. */
  private _socialIconsRow(): string {
    const icons: { url: string; bg: string; label: string; alt: string }[] = [
      {
        url: appConfig.socialFacebookUrl,
        bg: '#1877F2',
        label: 'f',
        alt: 'Facebook',
      },
      {
        url: appConfig.socialInstagramUrl,
        bg: '#C13584',
        label: 'IG',
        alt: 'Instagram',
      },
      {
        url: appConfig.socialLinkedinUrl,
        bg: '#0A66C2',
        label: 'in',
        alt: 'LinkedIn',
      },
      {
        url: appConfig.socialPinterestUrl,
        bg: '#E60023',
        label: 'P',
        alt: 'Pinterest',
      },
      {
        url: appConfig.socialYoutubeUrl,
        bg: '#FF0000',
        label: '▶',
        alt: 'YouTube',
      },
    ].filter((i) => i.url);
    if (!icons.length) return '';
    const cells = icons
      .map(
        (i) => `<td style="padding:0 5px;">
          <a href="${i.url}" target="_blank" title="${i.alt}" style="text-decoration:none;">
            <span style="display:inline-block;width:30px;height:30px;line-height:30px;border-radius:50%;background-color:${i.bg};color:#ffffff;text-align:center;font-size:13px;font-weight:700;font-family:Arial,Helvetica,sans-serif;">${i.label}</span>
          </a>
        </td>`,
      )
      .join('');
    return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:14px auto 0;"><tr>${cells}</tr></table>`;
  }

  /** Full branded footer: company name, addresses, contact line, social icons, automated-email notice. */
  private _emailFooter(): string {
    const BLUE = '#016bb2';
    const addrLines: string[] = [];
    if (appConfig.companyFactoryAddress)
      addrLines.push(
        `<div><strong style="color:${BLUE};">Factory:</strong> ${appConfig.companyFactoryAddress}</div>`,
      );
    if (appConfig.companyOfficeAddress)
      addrLines.push(
        `<div style="margin-top:5px;"><strong style="color:${BLUE};">Chennai Office:</strong> ${appConfig.companyOfficeAddress}</div>`,
      );

    const contactParts: string[] = [];
    if (appConfig.companyWebsite) {
      const href = /^https?:\/\//i.test(appConfig.companyWebsite)
        ? appConfig.companyWebsite
        : `https://${appConfig.companyWebsite}`;
      contactParts.push(
        `<a href="${href}" target="_blank" style="color:${BLUE};text-decoration:none;font-weight:600;">${appConfig.companyWebsite}</a>`,
      );
    }
    if (appConfig.companyPhone)
      contactParts.push(`📞 ${appConfig.companyPhone}`);
    if (appConfig.companyEmail)
      contactParts.push(
        `✉ <a href="mailto:${appConfig.companyEmail}" style="color:${BLUE};text-decoration:none;">${appConfig.companyEmail}</a>`,
      );

    return `
    <div style="background:#f8fafc;padding:26px 28px;text-align:center;border-top:1px solid #e2e8f0;">
      ${addrLines.length ? `<div style="font-size:12px;color:#475569;line-height:1.8;max-width:460px;margin:0 auto;">${addrLines.join('')}</div>` : ''}
      ${contactParts.length ? `<div style="margin-top:14px;font-size:12px;color:#64748b;">${contactParts.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>` : ''}
      ${this._socialIconsRow()}
    </div>`;
  }

  /** Validity window in days, taken from the quotation's own validity_days field (set at creation). */
  private _validityDays(data: any): number | null {
    const n = Number(data?.validity_days);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private _quotationHtml(data: any, pdfLink: string, hasLogo: boolean): string {
    const BLUE = '#016bb2';
    const co = appConfig.companyName;
    const qNo = data?.quotation_no || '—';
    const custName = data?.customer_name || 'Customer';
    const amount = `₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const dateStr = this._fmtDate(data?.created_at);
    const validityDays = this._validityDays(data);
    const validTillStr = data?.valid_till ? this._fmtDate(data.valid_till) : '';
    const validitySentence = validityDays
      ? `This quotation is valid for <strong>${validityDays} days</strong> from the date of issue${validTillStr ? `, until <strong>${validTillStr}</strong>` : ''}.`
      : 'This quotation is valid for a limited period from the date of issue.';
    return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">
    <div style="background:${BLUE};color:#fff;padding:32px 28px;text-align:center;">
      ${
        hasLogo
          ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" style="background:#ffffff;border-radius:8px;padding:10px 18px;"><img src="cid:hesh-logo" alt="${co}" style="display:block;max-width:170px;max-height:52px;"></td></tr></table>`
          : ''
      }
      <div style="margin-top:${hasLogo ? '16' : '0'}px;font-size:18px;font-weight:700;color:#ffffff;">${co}</div>
      <div style="margin-top:5px;font-size:12px;letter-spacing:.4px;color:#ffffff;opacity:.85;">Proforma Invoice</div>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;color:#0f172a;">Dear <strong>${custName}</strong>,</p>
      <p style="margin:0 0 14px;font-size:14px;color:#475569;line-height:1.65;">Please find attached your quotation. We hope it meets your requirements.</p>
      <p style="margin:0 0 14px;font-size:14px;color:#475569;line-height:1.65;">${validitySentence} Kindly review the details carefully — if any changes are required, we will share a revised quotation, and this version will no longer be valid.</p>
      <p style="margin:0 0 22px;font-size:14px;color:#475569;line-height:1.65;">Please note that the order will be taken up for processing only after the advance payment is received.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:5px 0;color:#64748b;width:130px;vertical-align:top;">Quotation No.</td><td style="padding:5px 0;font-weight:700;color:#0f172a;">${qNo}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b;vertical-align:top;">Date</td><td style="padding:5px 0;color:#0f172a;">${dateStr}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b;vertical-align:top;">Amount</td><td style="padding:5px 0;">
            <span style="font-weight:700;font-size:16px;color:${BLUE};">${amount}</span>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px;">(Inclusive of GST Taxes)</div>
          </td></tr>
        </table>
      </div>
      ${pdfLink ? `<div style="text-align:center;margin-bottom:24px;"><a href="${pdfLink}" target="_blank" style="display:inline-block;background:${BLUE};color:#fff;text-decoration:none;padding:11px 28px;border-radius:6px;font-weight:600;font-size:14px;">⬇ View / Download PDF</a><div style="font-size:11px;color:#94a3b8;margin-top:8px;">Or copy: <a href="${pdfLink}" style="color:${BLUE};word-break:break-all;">${pdfLink}</a></div></div>` : ''}
      <p style="margin:0;font-size:14px;color:#475569;">The PDF is also attached to this email for your convenience.</p>
      ${this._salesmanBlock(data)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
      <p style="margin:0;font-size:14px;color:#0f172a;">Regards,<br><strong>${appConfig.emailSignoffName}</strong></p>
      <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;font-style:italic;">This email was generated with the assistance of AI.</p>
    </div>
${this._emailFooter()}
  </div>
</body></html>`;
  }

  private _quotationText(data: any, pdfLink: string): string {
    const validityDays = this._validityDays(data);
    const validTillStr = data?.valid_till ? this._fmtDate(data.valid_till) : '';
    const validitySentence = validityDays
      ? `This quotation is valid for ${validityDays} days from the date of issue${validTillStr ? `, until ${validTillStr}` : ''}.`
      : 'This quotation is valid for a limited period from the date of issue.';
    return [
      `Dear ${data?.customer_name || 'Customer'},`,
      '',
      'Please find attached your quotation. We hope it meets your requirements.',
      '',
      `${validitySentence} Kindly review the details carefully — if any changes are required, we will share a revised quotation, and this version will no longer be valid.`,
      '',
      'Please note that the order will be taken up for processing only after the advance payment is received.',
      '',
      `Quotation No: ${data?.quotation_no || '—'}`,
      `Date: ${this._fmtDate(data?.created_at)}`,
      `Amount: ₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} (Inclusive of GST Taxes)`,
      pdfLink ? `\nDownload PDF:\n${pdfLink}` : '',
      ...(data?.salesman_name
        ? [
            '',
            `Your Sales Contact: ${data.salesman_name}${data.salesman_phone ? ` — ${data.salesman_phone}` : ''}`,
          ]
        : []),
      '',
      'Regards,',
      appConfig.emailSignoffName,
      '',
      'This email was generated with the assistance of AI.',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  private _orderHtml(data: any, pdfLink: string): string {
    const co = appConfig.companyName;
    const orderNo = data?.order_no || data?.order_number || '—';
    const custName = data?.customer_name || 'Customer';
    const amount = `₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const dateStr = this._fmtDate(data?.created_at);
    const status = (data?.status || '').replace(/_/g, ' ');
    return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">
    <div style="background:#005fb8;color:#fff;padding:22px 28px;">
      <div style="font-size:18px;font-weight:700;">${co}</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px;">Order Confirmation</div>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;">Dear <strong>${custName}</strong>,</p>
      <p style="margin:0 0 20px;color:#475569;">Your order has been confirmed by <strong>${co}</strong>. Please find the order details below.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:4px 0;color:#64748b;width:140px;">Order No.</td><td style="padding:4px 0;font-weight:700;color:#0f172a;">${orderNo}</td></tr>
          <tr><td style="padding:4px 0;color:#64748b;">Date</td><td style="padding:4px 0;color:#0f172a;">${dateStr}</td></tr>
          <tr><td style="padding:4px 0;color:#64748b;">Amount</td><td style="padding:4px 0;font-weight:700;font-size:16px;color:#005fb8;">${amount}</td></tr>
          ${status ? `<tr><td style="padding:4px 0;color:#64748b;">Status</td><td style="padding:4px 0;font-weight:600;color:#0f172a;">${status}</td></tr>` : ''}
        </table>
      </div>
      ${pdfLink ? `<div style="text-align:center;margin-bottom:24px;"><a href="${pdfLink}" target="_blank" style="display:inline-block;background:#005fb8;color:#fff;text-decoration:none;padding:11px 28px;border-radius:6px;font-weight:600;font-size:14px;">⬇ View / Download PDF</a><div style="font-size:11px;color:#94a3b8;margin-top:8px;">Or copy: <a href="${pdfLink}" style="color:#3b82f6;word-break:break-all;">${pdfLink}</a></div></div>` : ''}
      <p style="margin:0;color:#475569;font-size:14px;">The order confirmation PDF is also attached to this email.</p>
      ${this._salesmanBlock(data)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
      <p style="margin:0;font-size:14px;">Regards,<br><strong>${appConfig.emailSignoffName}</strong></p>
    </div>
${this._emailFooter()}
  </div>
</body></html>`;
  }

  private _orderText(data: any, pdfLink: string): string {
    const co = appConfig.companyName;
    return [
      `Dear ${data?.customer_name || 'Customer'},`,
      '',
      `Your order has been confirmed by ${co}.`,
      '',
      `Order No: ${data?.order_no || data?.order_number || '—'}`,
      `Date: ${this._fmtDate(data?.created_at)}`,
      `Amount: ₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      data?.status ? `Status: ${String(data.status).replace(/_/g, ' ')}` : '',
      pdfLink ? `\nDownload PDF:\n${pdfLink}` : '',
      ...(data?.salesman_name
        ? [
            '',
            `Your Sales Contact: ${data.salesman_name}${data.salesman_phone ? ` — ${data.salesman_phone}` : ''}`,
          ]
        : []),
      '',
      'Regards,',
      appConfig.emailSignoffName,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private _invoiceHtml(data: any): string {
    const co = appConfig.companyName;
    const invoiceNo = data?.invoice_no || '—';
    const custName = data?.customer_name || 'Customer';
    const total = `₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.1);">
    <div style="background:#1e3a8a;color:#fff;padding:22px 28px;">
      <div style="font-size:18px;font-weight:700;">${co}</div>
      <div style="font-size:12px;opacity:.8;margin-top:4px;">Invoice</div>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;">Dear <strong>${custName}</strong>,</p>
      <p style="margin:0 0 20px;color:#475569;">Please find attached your invoice from <strong>${co}</strong>.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:4px 0;color:#64748b;width:120px;">Invoice No.</td><td style="padding:4px 0;font-weight:700;color:#0f172a;">${invoiceNo}</td></tr>
          <tr><td style="padding:4px 0;color:#64748b;">Total</td><td style="padding:4px 0;font-weight:700;font-size:16px;color:#1e3a8a;">${total}</td></tr>
        </table>
      </div>
      <p style="margin:0;color:#475569;font-size:14px;">The invoice PDF is attached to this email.</p>
      ${this._salesmanBlock(data)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
      <p style="margin:0;font-size:14px;">Regards,<br><strong>${appConfig.emailSignoffName}</strong></p>
    </div>
${this._emailFooter()}
  </div>
</body></html>`;
  }

  private _invoiceText(data: any): string {
    const co = appConfig.companyName;
    return [
      `Dear ${data?.customer_name || 'Customer'},`,
      '',
      `Please find attached your invoice (${data?.invoice_no || '—'}) from ${co}.`,
      `Total: ₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ...(data?.salesman_name
        ? [
            '',
            `Your Sales Contact: ${data.salesman_name}${data.salesman_phone ? ` — ${data.salesman_phone}` : ''}`,
          ]
        : []),
      '',
      'Regards,',
      appConfig.emailSignoffName,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private _fmtDate(d: any): string {
    try {
      return d
        ? new Date(d).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '—';
    } catch {
      return '—';
    }
  }
}

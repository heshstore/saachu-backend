import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import { appConfig } from '../config/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (appConfig.smtpHost && appConfig.smtpUser) {
      this.transporter = nodemailer.createTransport({
        host:       appConfig.smtpHost,
        port:       appConfig.smtpPort,
        secure:     appConfig.smtpPort === 465,   // true only for port 465 (SSL)
        requireTLS: appConfig.smtpPort === 587,   // STARTTLS required for Hotmail/Outlook
        auth: {
          user: appConfig.smtpUser,
          pass: appConfig.smtpPass,
        },
      });
    }
  }

  /** Verify SMTP connectivity without sending a message. Call after startup to confirm config. */
  async verifySmtp(): Promise<{ ok: boolean; error?: string }> {
    this.logger.log('[SMTP_VERIFY_START]');
    if (!this.transporter) {
      const msg = 'Transporter is null — SMTP_HOST or SMTP_USER not configured';
      this.logger.error(`[SMTP_VERIFY_FAILED] ${msg}`);
      return { ok: false, error: msg };
    }
    try {
      await this.transporter.verify();
      this.logger.log('[SMTP_VERIFY_SUCCESS] SMTP connection and credentials verified');
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message ?? 'Unknown SMTP error';
      this.logger.error(`[SMTP_VERIFY_FAILED] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Plain-text email with attachment. */
  async sendDocument(to: string, subject: string, pdfPath: string) {
    return this.sendDocumentWithBody(
      to,
      subject,
      `Please find the attached document from ${appConfig.companyName}.`,
      pdfPath,
    );
  }

  /** Plain-text body + attachment. */
  async sendDocumentWithBody(to: string, subject: string, body: string, pdfPath: string) {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    }
    const fullPath = path.join(process.cwd(), pdfPath.replace(/^\//, ''));
    await this.transporter.sendMail({
      from: `"${appConfig.companyName}" <${appConfig.smtpUser}>`,
      to,
      subject,
      text: body,
      attachments: [{ filename: path.basename(fullPath), path: fullPath }],
    });
  }

  /** HTML email with optional attachment. */
  async sendHtml(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    pdfPath?: string;
  }) {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    }
    const mail: nodemailer.SendMailOptions = {
      from: `"${appConfig.companyName}" <${appConfig.smtpUser}>`,
      to:      opts.to,
      subject: opts.subject,
      html:    opts.html,
      text:    opts.text,
    };
    if (opts.pdfPath) {
      const fullPath = path.join(process.cwd(), opts.pdfPath.replace(/^\//, ''));
      mail.attachments = [{ filename: path.basename(fullPath), path: fullPath }];
    }
    await this.transporter.sendMail(mail);
  }
}

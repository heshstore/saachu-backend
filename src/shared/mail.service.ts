import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import * as fs from 'fs';
import { appConfig } from '../config/config';

/**
 * Sniffs actual image bytes for the MIME type instead of trusting the file
 * extension — some static assets in this repo are mislabeled (e.g. a JPEG
 * saved as "logo.png"), and email clients are far stricter than pdfmake
 * about a declared Content-Type matching the real file format.
 */
function detectImageMime(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
      return 'image/jpeg';
    if (
      buf
        .slice(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return 'image/png';
    if (
      buf.slice(0, 6).toString('ascii') === 'GIF87a' ||
      buf.slice(0, 6).toString('ascii') === 'GIF89a'
    )
      return 'image/gif';
    if (
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP'
    )
      return 'image/webp';
  } catch {
    // fall through — let nodemailer guess from the extension
  }
  return undefined;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (appConfig.smtpHost && appConfig.smtpUser) {
      this.transporter = nodemailer.createTransport({
        host: appConfig.smtpHost,
        port: appConfig.smtpPort,
        secure: appConfig.smtpPort === 465, // true only for port 465 (SSL)
        requireTLS: appConfig.smtpPort === 587, // STARTTLS required for Hotmail/Outlook
        auth: {
          user: appConfig.smtpUser,
          pass: appConfig.smtpPass,
        },
        // Nodemailer's default connection timeout is 2 minutes — far longer
        // than the frontend's own request timeout, so a blocked/unreachable
        // mail server used to hang silently instead of failing fast with a
        // clear error. 15s is generous for a real handshake but still well
        // under the client-side cutoff.
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000,
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
      this.logger.log(
        '[SMTP_VERIFY_SUCCESS] SMTP connection and credentials verified',
      );
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
  async sendDocumentWithBody(
    to: string,
    subject: string,
    body: string,
    pdfPath: string,
  ) {
    if (!this.transporter) {
      throw new Error(
        'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env',
      );
    }
    const fullPath = path.join(process.cwd(), pdfPath.replace(/^\//, ''));
    await this.transporter.sendMail({
      from: `"${appConfig.emailFromName}" <${appConfig.smtpUser}>`,
      to,
      subject,
      text: body,
      attachments: [{ filename: path.basename(fullPath), path: fullPath }],
    });
  }

  /** HTML email with optional attachment and inline (cid-referenced) images. */
  async sendHtml(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    pdfPath?: string;
    inlineImages?: { cid: string; path: string }[];
  }) {
    if (!this.transporter) {
      throw new Error(
        'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env',
      );
    }
    const mail: nodemailer.SendMailOptions = {
      from: `"${appConfig.emailFromName}" <${appConfig.smtpUser}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    };
    const attachments: nodemailer.SendMailOptions['attachments'] = [];
    if (opts.pdfPath) {
      const fullPath = path.join(
        process.cwd(),
        opts.pdfPath.replace(/^\//, ''),
      );
      attachments.push({ filename: path.basename(fullPath), path: fullPath });
    }
    for (const img of opts.inlineImages ?? []) {
      attachments.push({
        filename: path.basename(img.path),
        path: img.path,
        cid: img.cid,
        contentType: detectImageMime(img.path),
      });
    }
    if (attachments.length) mail.attachments = attachments;
    await this.transporter.sendMail(mail);
  }
}

import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import { appConfig } from '../config/config';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (appConfig.smtpHost && appConfig.smtpUser) {
      this.transporter = nodemailer.createTransport({
        host: appConfig.smtpHost,
        port: appConfig.smtpPort,
        secure: appConfig.smtpPort === 465,
        auth: {
          user: appConfig.smtpUser,
          pass: appConfig.smtpPass,
        },
      });
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

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

  async sendDocument(to: string, subject: string, pdfPath: string) {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    }

    const fullPath = path.join(process.cwd(), pdfPath.replace(/^\//, ''));
    await this.transporter.sendMail({
      from: `"${appConfig.companyName}" <${appConfig.smtpUser}>`,
      to,
      subject,
      text: `Please find the attached document from ${appConfig.companyName}.`,
      attachments: [
        {
          filename: path.basename(fullPath),
          path: fullPath,
        },
      ],
    });
  }
}

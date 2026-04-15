import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { MailService } from './mail.service';

@Module({
  providers: [PdfService, MailService],
  exports: [PdfService, MailService],
})
export class SharedModule {}

import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { MailService } from './mail.service';
import { DbHealthService } from './db-health.service';

@Global()
@Module({
  providers: [PdfService, MailService, DbHealthService],
  exports: [PdfService, MailService, DbHealthService],
})
export class SharedModule {}

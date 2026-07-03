import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { MailService } from './mail.service';
import { DbHealthService } from './db-health.service';
import { DocumentActionLogService } from './document-action-log.service';

@Global()
@Module({
  providers: [PdfService, MailService, DbHealthService, DocumentActionLogService],
  exports: [PdfService, MailService, DbHealthService, DocumentActionLogService],
})
export class SharedModule {}

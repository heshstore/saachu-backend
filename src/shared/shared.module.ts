import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { MailService } from './mail.service';
import { DbHealthService } from './db-health.service';
import { DocumentActionLogService } from './document-action-log.service';
import { ShortLinkController } from './short-link.controller';

@Global()
@Module({
  controllers: [ShortLinkController],
  providers: [
    PdfService,
    MailService,
    DbHealthService,
    DocumentActionLogService,
  ],
  exports: [PdfService, MailService, DbHealthService, DocumentActionLogService],
})
export class SharedModule {}

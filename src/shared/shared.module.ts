import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { MailService } from './mail.service';

@Global()
@Module({
  providers: [PdfService, MailService],
  exports: [PdfService, MailService],
})
export class SharedModule {}

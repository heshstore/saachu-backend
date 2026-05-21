import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { CrmWhatsAppService } from './crm-whatsapp.service';
import { CrmWhatsAppController } from './crm-whatsapp.controller';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsAppSession, WhatsAppMessage])],
  controllers: [CrmWhatsAppController],
  providers: [CrmWhatsAppService],
  exports: [CrmWhatsAppService],
})
export class CrmWhatsAppModule {}

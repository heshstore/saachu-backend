import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppSession } from './entities/whatsapp-session.entity';
import { WhatsAppMessage } from './entities/whatsapp-message.entity';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppAdminController } from './whatsapp-admin.controller';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsAppSession, WhatsAppMessage])],
  controllers: [WhatsAppController, WhatsAppAdminController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsappModule {}

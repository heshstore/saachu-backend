import { Module } from '@nestjs/common';
import { WhatsappEngineModule } from './whatsapp-engine/whatsapp-engine.module';

@Module({
  imports: [WhatsappEngineModule],
  exports: [WhatsappEngineModule],
})
export class MarketingModule {}

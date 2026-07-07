import { Module } from '@nestjs/common';
import { PaymentRemindersService } from './payment-reminders.service';
import { NotificationsModule } from '../notifications/notification.module';
import { CrmWhatsAppModule } from '../crm-whatsapp/crm-whatsapp.module';

@Module({
  imports: [NotificationsModule, CrmWhatsAppModule],
  providers: [PaymentRemindersService],
  exports: [PaymentRemindersService],
})
export class PaymentRemindersModule {}

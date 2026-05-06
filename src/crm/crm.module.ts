import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuotationModule } from '../quotation/quotation.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { NotificationsModule } from '../notifications/notification.module';
import { Lead } from './entities/lead.entity';
import { LeadNote } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { CrmSettings } from './entities/crm-settings.entity';
import { LeadAuditLog } from './entities/lead-audit-log.entity';
import { LeadAlert } from './entities/lead-alert.entity';
import { User } from '../users/entities/user.entity';
import { LeadService } from './lead.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadAlertService } from './lead-alert.service';
import { LeadTagService } from './lead-tag.service';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService } from './decision-engine.service';
import { LeadAutomationService } from './lead-automation.service';
import { LeadController } from './lead.controller';
import { WebhookController } from './webhook.controller';
import { ShopifyApiController } from './shopify-api.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lead, LeadNote, LeadFollowUp, CrmSettings,
      LeadAuditLog, LeadAlert,
      User,
    ]),
    QuotationModule,
    WhatsappModule,
    NotificationsModule,
  ],
  controllers: [LeadController, WebhookController, ShopifyApiController, AnalyticsController],
  providers: [
    LeadService,
    LeadAuditService,
    LeadAlertService,
    LeadTagService,
    LeadAssignmentService,
    DecisionEngineService,
    LeadAutomationService,
    AnalyticsService,
  ],
  exports: [LeadService],
})
export class CrmModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from './entities/lead.entity';
import { LeadNote } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { CrmSettings } from './entities/crm-settings.entity';
import { User } from '../users/entities/user.entity';
import { LeadService } from './lead.service';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService } from './decision-engine.service';
import { LeadController } from './lead.controller';
import { WebhookController } from './webhook.controller';
import { ShopifyApiController } from './shopify-api.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Lead, LeadNote, LeadFollowUp, CrmSettings, User]),
  ],
  controllers: [LeadController, WebhookController, ShopifyApiController, AnalyticsController],
  providers: [LeadService, LeadAssignmentService, DecisionEngineService, AnalyticsService],
  exports: [LeadService],
})
export class CrmModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketingWhatsAppService } from './marketing-whatsapp.service';

import { ShopifyCatalogItem } from '../../shopify-catalog/entities/shopify-catalog-item.entity';
import { WhatsappNumber } from './entities/whatsapp-number.entity';
import { MarketingCampaign } from './entities/marketing-campaign.entity';
import { MarketingTemplate } from './entities/marketing-template.entity';
import { MarketingAudience } from './entities/marketing-audience.entity';
import { WhatsappMessageQueue } from './entities/whatsapp-message-queue.entity';
import { WhatsappMessageLog } from './entities/whatsapp-message-log.entity';
import { WhatsappReply } from './entities/whatsapp-reply.entity';
import { PromotionProductRotation } from './entities/promotion-product-rotation.entity';

import { CampaignsController } from './campaigns/campaigns.controller';
import { TemplatesController } from './templates/templates.controller';
import { AudienceController } from './audience/audience.controller';
import { QueueController } from './queue/queue.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { InboxController } from './inbox/inbox.controller';
import { NumbersController } from './numbers/numbers.controller';
import { EngineHealthController } from './engine/engine-health.controller';

import { CampaignsService } from './campaigns/campaigns.service';
import { TemplatesService } from './templates/templates.service';
import { AudienceService } from './audience/audience.service';
import { QueueService } from './queue/queue.service';
import { SenderService } from './sender/sender.service';
import { AnalyticsService } from './analytics/analytics.service';
import { InboxService } from './inbox/inbox.service';
import { NumbersService } from './numbers/numbers.service';

import { AudienceAiService } from './ai/audience-ai.service';
import { ProductAiService } from './ai/product-ai.service';
import { MessageAiService } from './ai/message-ai.service';
import { TimingAiService } from './ai/timing-ai.service';
import { RiskAiService } from './ai/risk-ai.service';

import { AutonomousEngineService } from './engine/autonomous-engine.service';
import { EngineAuditService } from './engine/engine-audit.service';
import { EngineHealthService } from './engine/engine-health.service';
import { EngineAutoPauseService } from './engine/engine-auto-pause.service';
import { NumberRecoveryService } from './engine/number-recovery.service';
import { StabilityReportService } from './engine/stability-report.service';
import { ScaleReadinessService } from './engine/scale-readiness.service';
import { ReplyIntelligenceService } from './inbox/reply-intelligence.service';
import { ValidateService } from './validate/validate.service';
import { ValidateController } from './validate/validate.controller';
import { ProcessingWatchdogService } from './engine/processing-watchdog.service';
import { SchemaValidatorService } from './engine/schema-validator.service';
import { PromotionProductSelectionService } from './promotion/promotion-product-selection.service';
import { PromotionAiTemplateService } from './promotion/promotion-ai-template.service';
import { EngineSettingsService } from './engine/engine-settings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WhatsappNumber,
      MarketingCampaign,
      MarketingTemplate,
      MarketingAudience,
      WhatsappMessageQueue,
      WhatsappMessageLog,
      WhatsappReply,
      ShopifyCatalogItem,
      PromotionProductRotation,
    ]),
  ],
  controllers: [
    CampaignsController,
    TemplatesController,
    AudienceController,
    QueueController,
    AnalyticsController,
    InboxController,
    NumbersController,
    EngineHealthController,
    ValidateController,
  ],
  providers: [
    CampaignsService,
    TemplatesService,
    AudienceService,
    QueueService,
    SenderService,
    AnalyticsService,
    InboxService,
    NumbersService,
    AudienceAiService,
    ProductAiService,
    MessageAiService,
    TimingAiService,
    RiskAiService,
    MarketingWhatsAppService,
    AutonomousEngineService,
    EngineAuditService,
    EngineHealthService,
    EngineAutoPauseService,
    NumberRecoveryService,
    StabilityReportService,
    ScaleReadinessService,
    ReplyIntelligenceService,
    ValidateService,
    ProcessingWatchdogService,
    SchemaValidatorService,
    PromotionProductSelectionService,
    PromotionAiTemplateService,
    EngineSettingsService,
  ],
  exports: [
    CampaignsService,
    TemplatesService,
    AudienceService,
    QueueService,
    SenderService,
    AnalyticsService,
    InboxService,
    NumbersService,
    EngineAuditService,
    EngineSettingsService,
  ],
})
export class WhatsappEngineModule {
  // Forces NestJS to eagerly instantiate MarketingWhatsAppService so OnModuleInit always fires.
  constructor(private readonly _mktWa: MarketingWhatsAppService) {}
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WhatsAppNumberStatus, QueueStatus } from '../entities/enums';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingTemplate } from '../entities/marketing-template.entity';
import { AudienceAiService } from '../ai/audience-ai.service';
import { MessageAiService } from '../ai/message-ai.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { QueueService } from '../queue/queue.service';
import { TemplatesService } from '../templates/templates.service';
import { NumbersService } from '../numbers/numbers.service';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

@Injectable()
export class AutonomousEngineService {
  private readonly logger = new Logger(AutonomousEngineService.name);

  constructor(
    private readonly audienceAi: AudienceAiService,
    private readonly messageAi: MessageAiService,
    private readonly timingAi: TimingAiService,
    private readonly queueService: QueueService,
    private readonly templatesService: TemplatesService,
    private readonly numbersService: NumbersService,
    private readonly auditService: EngineAuditService,
  ) {}

  // Reset daily sent counters at midnight
  @Cron('0 0 * * *')
  async resetDailyCounters(): Promise<void> {
    this.logger.log('[Engine] Resetting daily sent counters');
    await this.numbersService.resetDailyCounts();
  }

  // Daily calibration at 7:00 AM: scores + cooldowns + template weights
  @Cron('0 7 * * *')
  async refreshAudienceScores(): Promise<void> {
    this.logger.log('[Engine] Running daily calibration');
    await this.audienceAi.updateScores();
    await this.audienceAi.applyCooldowns();
    await this.templatesService.updatePerformanceWeights();
    this.logger.log('[Engine] Daily calibration complete');
  }

  // Build the day's queue at 8:30 AM
  @Cron('30 8 * * *')
  async buildDailyQueue(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') {
      this.logger.warn('[Engine] Disabled via WHATSAPP_ENGINE_ENABLED=false — skipping queue build');
      return;
    }
    this.logger.log('[Engine] Building daily queue');
    const result = await this._buildQueue();
    this.logger.log(`[Engine] Daily queue built: ${result.queued} items across ${result.numbers} numbers`);
    await this.auditService.log({
      event: AuditEvent.QUEUE_CREATED,
      reason: `Daily queue build: ${result.queued} items across ${result.numbers} numbers`,
      metadata: result,
    });
  }

  async _buildQueue(): Promise<{ queued: number; numbers: number }> {
    const allNumbers = await this.numbersService.findAll();
    const safeNumbers = allNumbers.filter(
      (n) =>
        n.is_active &&
        n.status === WhatsAppNumberStatus.ACTIVE &&
        n.daily_sent < n.daily_limit,
    );

    if (!safeNumbers.length) {
      this.logger.warn('[Engine] No safe numbers available for queue building');
      return { queued: 0, numbers: 0 };
    }

    const rawAudience = await this.audienceAi.filterByQuality(30);
    // Honour daily audience cap (WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE) — critical for pilot safety
    const maxDaily = parseInt(process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE || '999999', 10);
    const audience = rawAudience.slice(0, maxDaily);
    if (!audience.length) {
      this.logger.warn('[Engine] No eligible audience members found');
      return { queued: 0, numbers: safeNumbers.length };
    }
    if (rawAudience.length > audience.length) {
      this.logger.log(`[Engine] Audience capped: ${audience.length}/${rawAudience.length} eligible (MAX_DAILY_AUDIENCE=${maxDaily})`);
    }

    const allTemplates = await this.templatesService.findAll();
    const activeTemplates = allTemplates.filter((t) => t.is_active);

    if (!activeTemplates.length) {
      this.logger.warn('[Engine] No active templates found, skipping queue build');
      return { queued: 0, numbers: safeNumbers.length };
    }

    const items: Partial<WhatsappMessageQueue>[] = [];
    const allocatedPerNumber: Record<string, number> = {};
    for (const n of safeNumbers) {
      allocatedPerNumber[n.id] = 0;
    }

    // Product rotation: no single category may exceed 40% of the day's queue
    const MAX_CATEGORY_SHARE = 0.40;
    const categoryCount: Record<string, number> = {};

    for (let i = 0; i < audience.length; i++) {
      const member = audience[i];
      const number = safeNumbers[i % safeNumbers.length];

      if (allocatedPerNumber[number.id] >= number.daily_limit) continue;

      // Pick template, respecting category saturation
      const template = this._balancedTemplate(activeTemplates, categoryCount, audience.length, MAX_CATEGORY_SHARE);
      if (!template) continue;

      const scheduledAt = await this.timingAi.getOptimalSendTime(member.phone);

      items.push({
        campaign_id: null,
        number_id: number.id,
        customer_phone: member.phone,
        customer_id: member.customer_id ?? undefined,
        template_id: template.id,
        scheduled_at: scheduledAt,
        status: QueueStatus.PENDING,
        priority: Math.round(Number(member.quality_score)),
        message_payload: {
          name: member.name ?? '',
          city: member.city ?? '',
          business_type: member.business_type ?? '',
        },
      });

      const cat = template.product_category ?? 'general';
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
      allocatedPerNumber[number.id]++;
    }

    const queued = await this.queueService.bulkEnqueue(items);
    return { queued, numbers: safeNumbers.length };
  }

  // Weighted template selection with category saturation guard.
  // Templates whose product_category has already reached MAX_CATEGORY_SHARE of the queue
  // are excluded from selection for this slot.
  private _balancedTemplate(
    templates: MarketingTemplate[],
    categoryCount: Record<string, number>,
    totalAudience: number,
    maxShare: number,
  ): MarketingTemplate | null {
    const maxPerCategory = Math.ceil(totalAudience * maxShare);

    // Filter out over-saturated categories
    const eligible = templates.filter((t) => {
      const cat = t.product_category ?? 'general';
      return (categoryCount[cat] ?? 0) < maxPerCategory;
    });

    const pool = eligible.length > 0 ? eligible : templates;

    const totalWeight = pool.reduce((sum, t) => sum + (Number(t.performance_weight) || 1.0), 0);
    let rand = Math.random() * totalWeight;
    for (const t of pool) {
      rand -= Number(t.performance_weight) || 1.0;
      if (rand <= 0) return t;
    }
    return pool[pool.length - 1] ?? null;
  }
}

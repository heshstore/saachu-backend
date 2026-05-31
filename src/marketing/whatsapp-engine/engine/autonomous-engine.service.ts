import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { WhatsAppNumberStatus, QueueStatus, CampaignStatus, MessageType, CTAType } from '../entities/enums';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingTemplate } from '../entities/marketing-template.entity';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';
import { AudienceAiService } from '../ai/audience-ai.service';
import { MessageAiService } from '../ai/message-ai.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { QueueService } from '../queue/queue.service';
import { TemplatesService } from '../templates/templates.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { NumbersService } from '../numbers/numbers.service';
import { AudienceService } from '../audience/audience.service';
import { EngineAuditService, AuditEvent } from './engine-audit.service';
import { EngineSettingsService } from './engine-settings.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';

@Injectable()
export class AutonomousEngineService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousEngineService.name);
  private _running = false;

  async onModuleInit(): Promise<void> {
    const bypass = process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true';
    const testOnly = process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true';
    const enabled = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    this.logger.log(`[MKT_QUEUE_GATE] onModuleInit — enabled=${enabled} testOnly=${testOnly} bypass=${bypass}`);

    if (testOnly) {
      const testPhones = await this.audienceService.getTestPhones();
      this.logger.log(`[MKT_TEST_CONTACTS_FINAL] count=${testPhones.length} phones=${JSON.stringify(testPhones)}`);
    }

    if (!bypass || !testOnly || !enabled) return;
    await this._ensureTestSetup();
    this.logger.log('[MKT_QUEUE_GATE] TEST_ONLY+BYPASS: triggering immediate startup queue build');
    const result = await this._buildQueue();
    this.logger.log(`[MKT_QUEUE_GATE] Startup queue build complete: queued=${result.queued} numbers=${result.numbers}`);
  }

  private static readonly STORE_URL = 'https://www.heshstore.in';

  constructor(
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
    private readonly audienceAi: AudienceAiService,
    private readonly messageAi: MessageAiService,
    private readonly timingAi: TimingAiService,
    private readonly queueService: QueueService,
    private readonly templatesService: TemplatesService,
    private readonly campaignsService: CampaignsService,
    private readonly numbersService: NumbersService,
    private readonly audienceService: AudienceService,
    private readonly auditService: EngineAuditService,
    private readonly engineSettings: EngineSettingsService,
    private readonly whatsAppService: MarketingWhatsAppService,
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
    if (this._running) {
      this.logger.warn('[Engine] buildDailyQueue already running — skipping re-entrant call');
      return;
    }
    this._running = true;

    try {
    // Require at least one RUNNING campaign OR auto AI mode ON
    const campaigns = await this.campaignsService.findAll();
    const hasRunning = campaigns.some((c) => c.status === CampaignStatus.RUNNING);
    if (!hasRunning) {
      const autoAiMode = await this.engineSettings.getAutoAiMode();
      if (!autoAiMode) {
        this.logger.warn('[Engine] No running campaigns and auto AI mode is OFF — skipping daily queue build');
        return;
      }
      this.logger.log('[Engine] No running campaigns — auto AI mode ON, building from active AI templates');
    }

    this.logger.log('[Engine] Building daily queue');
    const result = await this._buildQueue();
    this.logger.log(`[Engine] Daily queue built: ${result.queued} items across ${result.numbers} numbers`);
    await this.auditService.log({
      event: AuditEvent.QUEUE_CREATED,
      reason: `Daily queue build: ${result.queued} items across ${result.numbers} numbers`,
      metadata: result,
    });
    } finally {
      this._running = false;
    }
  }

  async _buildQueue(): Promise<{ queued: number; numbers: number }> {
    this.logger.log(
      `[MKT_QUEUE_GATE] _buildQueue start — engine_enabled=${process.env.WHATSAPP_ENGINE_ENABLED} ` +
      `test_only=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW} ` +
      `maxDaily=${process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE}`,
    );

    const allNumbers = await this.numbersService.findAll();
    const sendableNumbers = allNumbers.filter(
      (n) =>
        n.is_active &&
        n.status === WhatsAppNumberStatus.ACTIVE &&
        n.daily_sent < n.daily_limit &&
        n.wa_state === 'ready' &&
        this.whatsAppService.isConnected(n.id),
    );

    this.logger.log(
      `[MKT_QUEUE_GATE] numbers: total=${allNumbers.length} sendable=${sendableNumbers.length} ` +
      `ready_in_db=${allNumbers.filter(n => n.wa_state === 'ready').length}`,
    );
    if (!sendableNumbers.length) {
      this.logger.warn('[MKT_QUEUE_GATE] reason=no_connected_numbers — zero sendable numbers (is_active+ready+liveAndReady); skipping build');
      return { queued: 0, numbers: 0 };
    }

    // Dedup: skip phones already in an active (PENDING/PROCESSING) queue item
    const activePhones = await this.queueService.findActivePhonesSet();
    this.logger.log(`[MKT_QUEUE_GATE] active_queue_phones=${activePhones.size} phones=${JSON.stringify([...activePhones])}`);

    const rawAudience = await this.audienceAi.filterByQuality(30);
    // Honour daily audience cap (WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE) — critical for pilot safety
    const maxDaily = parseInt(process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE || '999999', 10);
    const audience = rawAudience.slice(0, maxDaily);
    this.logger.log(`[MKT_QUEUE_GATE] audience: raw=${rawAudience.length} capped=${audience.length} maxDaily=${maxDaily}`);
    if (!audience.length) {
      this.logger.warn('[MKT_QUEUE_SKIP_REASON] No eligible audience (quality_score>=30, is_whatsapp_valid=true, opt_out=false, cooldown expired) — skipping build');
      return { queued: 0, numbers: sendableNumbers.length };
    }
    if (rawAudience.length > audience.length) {
      this.logger.log(`[MKT_QUEUE_GATE] Audience capped: ${audience.length}/${rawAudience.length} eligible (MAX_DAILY_AUDIENCE=${maxDaily})`);
    }

    const allTemplates = await this.templatesService.findAll();
    const activeTemplates = allTemplates.filter((t) => t.is_active);

    this.logger.log(`[MKT_QUEUE_GATE] templates: total=${allTemplates.length} active=${activeTemplates.length}`);
    if (!activeTemplates.length) {
      this.logger.warn('[MKT_QUEUE_SKIP_REASON] No active templates — skipping build');
      return { queued: 0, numbers: sendableNumbers.length };
    }

    // Build template_id → campaign_id map from RUNNING campaigns
    // Also build campaign_id → catalog product map for product-driven campaigns
    // Also build campaign_id → daily_target for per-campaign queue cap
    const allCampaigns = await this.campaignsService.findAll();
    const templateToCampaign = new Map<string, string>();
    const campaignToProduct = new Map<string, ShopifyCatalogItem>();
    const campaignDailyTargets = new Map<string, number>();
    const runningCampaignIds: string[] = [];

    for (const c of allCampaigns) {
      if (c.template_id && c.status === CampaignStatus.RUNNING) {
        templateToCampaign.set(c.template_id, c.id);
      }
      if (c.status === CampaignStatus.RUNNING) {
        if (c.daily_target) {
          campaignDailyTargets.set(c.id, c.daily_target);
          runningCampaignIds.push(c.id);
        }
        if (c.product_id) {
          const item = await this.catalogRepo
            .findOne({ where: { id: c.product_id, syncIgnored: false } })
            .catch(() => null);
          if (item) campaignToProduct.set(c.id, item);
        }
      }
    }

    // Load today's existing row counts per campaign — used to enforce daily_target idempotently
    const existingTodayCounts = runningCampaignIds.length
      ? await this.queueService.countTodayByCampaign(runningCampaignIds)
      : new Map<string, number>();
    // Track how many rows we add this run per campaign
    const addedThisRunByCampaign = new Map<string, number>();

    this.logger.log(
      `[MKT_QUEUE_GATE] campaign_map_entries=${templateToCampaign.size} product_campaigns=${campaignToProduct.size} ` +
      `campaigns_with_targets=${campaignDailyTargets.size}`,
    );

    this.logger.log(
      `[MKT_QUEUE_INPUT] audience=${audience.length} templates=${activeTemplates.length} ` +
      `sendable_numbers=${sendableNumbers.map(n => n.phone).join(',')} ` +
      `audience_phones=${JSON.stringify(audience.map(a => a.phone))}`,
    );

    const items: Partial<WhatsappMessageQueue>[] = [];
    const allocatedPerNumber: Record<string, number> = {};
    for (const n of sendableNumbers) {
      allocatedPerNumber[n.id] = 0;
    }

    // Product rotation: no single category may exceed 40% of the day's queue
    const MAX_CATEGORY_SHARE = 0.40;
    const categoryCount: Record<string, number> = {};

    for (let i = 0; i < audience.length; i++) {
      const member = audience[i];
      const number = sendableNumbers[i % sendableNumbers.length];

      if (allocatedPerNumber[number.id] >= number.daily_limit) continue;

      // Skip phones already queued today (any status — sent, skipped, failed, or pending)
      if (activePhones.has(member.phone)) {
        this.logger.log(`[MKT_QUEUE_SKIP_DUPE] phone=${member.phone} already in today's queue — skipping`);
        continue;
      }

      // Pick template, respecting category saturation
      const template = this._balancedTemplate(activeTemplates, categoryCount, audience.length, MAX_CATEGORY_SHARE);
      if (!template) continue;

      const campaignId = templateToCampaign.get(template.id) ?? null;

      // Enforce per-campaign daily_target cap
      if (campaignId && campaignDailyTargets.has(campaignId)) {
        const target  = campaignDailyTargets.get(campaignId)!;
        const existing = existingTodayCounts.get(campaignId) ?? 0;
        const added    = addedThisRunByCampaign.get(campaignId) ?? 0;
        if (existing + added >= target) {
          this.logger.log(
            `[MKT_QUEUE_SKIP_CAP] campaign_id=${campaignId} target=${target} ` +
            `existingToday=${existing} addedThisRun=${added} — daily cap reached, skipping phone=${member.phone}`,
          );
          continue;
        }
      }

      const scheduledAt = await this.timingAi.getOptimalSendTime(member.phone);
      const catalogItem = campaignId ? campaignToProduct.get(campaignId) ?? null : null;

      const productFields = catalogItem
        ? {
            product_name:  catalogItem.itemName ?? '',
            product_sku:   catalogItem.sku ?? '',
            product_image: catalogItem.image ?? '',
            product_link:  AutonomousEngineService.STORE_URL,
          }
        : {};

      items.push({
        campaign_id:    campaignId,
        number_id:      number.id,
        product_id:     catalogItem?.id ?? undefined,
        customer_phone: member.phone,
        customer_id:    member.customer_id ?? undefined,
        template_id:    template.id,
        scheduled_at:   scheduledAt,
        status:         QueueStatus.PENDING,
        priority:       Math.round(Number(member.quality_score)),
        message_payload: {
          name:          member.name ?? '',
          city:          member.city ?? '',
          business_type: member.business_type ?? '',
          sender_phone:  number.phone,
          ...productFields,
        },
      });
      this.logger.log(
        `[MKT_QUEUE_ITEM] phone=${member.phone} template="${template.template_name}" number=${number.phone} ` +
        `campaign_id=${campaignId ?? 'none'} scheduled_at=${scheduledAt.toISOString()}`,
      );

      // Update per-campaign add counter
      if (campaignId) {
        addedThisRunByCampaign.set(campaignId, (addedThisRunByCampaign.get(campaignId) ?? 0) + 1);
      }

      const cat = template.product_category ?? 'general';
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
      allocatedPerNumber[number.id]++;
    }

    this.logger.log(`[MKT_QUEUE_FINAL] items assembled=${items.length} phones=${JSON.stringify(items.map(i => i.customer_phone))}`);
    const queued = await this.queueService.bulkEnqueue(items);
    if (queued > 0) {
      this.logger.log(`[MKT_QUEUE_CREATED] queued=${queued} phones=${JSON.stringify(items.map(i => i.customer_phone))}`);
    }

    // Per-campaign summary log
    for (const [cid, added] of addedThisRunByCampaign) {
      const existingToday = existingTodayCounts.get(cid) ?? 0;
      const dailyTarget   = campaignDailyTargets.get(cid) ?? 0;
      this.logger.log(
        `[MKT_QUEUE_BUILD] campaignId=${cid} existingToday=${existingToday} ` +
        `dailyTarget=${dailyTarget} newRows=${added} skippedDuplicates=${existingToday}`,
      );
    }

    this.logger.log(`[MKT_QUEUE_GATE] _buildQueue complete: queued=${queued} numbers=${sendableNumbers.length}`);
    return { queued, numbers: sendableNumbers.length };
  }

  // Idempotent: creates the default test template + campaign if none exist.
  // Only called when TEST_ONLY+BYPASS mode is active.
  private async _ensureTestSetup(): Promise<void> {
    // ── Template ─────────────────────────────────────────────────────────────
    const allTemplates = await this.templatesService.findAll();
    const byName = allTemplates.find((t) => t.template_name === 'AI Test Campaign');
    let template: MarketingTemplate;

    if (byName) {
      template = byName;
      if (!byName.is_active) {
        await this.templatesService.update(byName.id, { is_active: true });
        this.logger.log(`[MKT_TEMPLATE_AUTO_CREATED] re-activated existing template id=${byName.id}`);
      } else {
        this.logger.log(`[MKT_TEMPLATE_AUTO_CREATED] skipped — template "AI Test Campaign" already exists id=${byName.id}`);
      }
    } else {
      const activeAlready = allTemplates.filter((t) => t.is_active);
      if (activeAlready.length > 0) {
        template = activeAlready[0];
        this.logger.log(
          `[MKT_TEMPLATE_AUTO_CREATED] skipped — ${activeAlready.length} active template(s) exist, using "${template.template_name}" id=${template.id}`,
        );
      } else {
        template = await this.templatesService.create({
          template_name: 'AI Test Campaign',
          message_body:
            'Hello {{name}}, this is a live WhatsApp engine test from Saachu App. Reply YES if you received this message.',
          product_category: 'TEST',
          is_active: true,
          performance_weight: 1.0,
          message_type: MessageType.TEXT,
          cta_type: CTAType.NONE,
        });
        this.logger.log(`[MKT_TEMPLATE_AUTO_CREATED] created id=${template.id} name="${template.template_name}"`);
      }
    }

    // ── Campaign ─────────────────────────────────────────────────────────────
    const allCampaigns = await this.campaignsService.findAll();
    const existingCampaign = allCampaigns.find((c) => c.campaign_name === 'AI Engine Test Campaign');
    if (existingCampaign) {
      this.logger.log(
        `[MKT_CAMPAIGN_AUTO_CREATED] skipped — campaign "${existingCampaign.campaign_name}" already exists (status=${existingCampaign.status})`,
      );
    } else {
      const campaign = await this.campaignsService.create({
        campaign_name: 'AI Engine Test Campaign',
        status: CampaignStatus.RUNNING,
        template_id: template.id,
        daily_target: 10,
        notes: 'Auto-created for TEST_ONLY mode — autonomous engine validation',
      });
      this.logger.log(
        `[MKT_CAMPAIGN_AUTO_CREATED] created id=${campaign.id} template_id=${template.id}`,
      );
    }
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

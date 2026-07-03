import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import {
  WhatsAppNumberStatus,
  QueueStatus,
  CampaignStatus,
  TemplateMode,
} from '../entities/enums';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingTemplate } from '../entities/marketing-template.entity';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
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
import {
  getMatureDailyCapacity,
  getReleaseAllowance,
} from '../shared/number-limits';
import { isValidationContact } from '../shared/validation-mode';
import { getIstDayBounds } from '../shared/ist-time';
import { NumberConnectionState } from '../shared/number-state';

@Injectable()
export class AutonomousEngineService implements OnModuleInit {
  private readonly logger = new Logger(AutonomousEngineService.name);
  private _running = false;

  async onModuleInit(): Promise<void> {
    const bypass = process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true';
    const testOnly = process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true';
    const enabled = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    this.logger.log(
      `[MKT_QUEUE_GATE] onModuleInit — enabled=${enabled} testOnly=${testOnly} bypass=${bypass}`,
    );

    if (testOnly) {
      const testPhones = await this.audienceService.getTestPhones();
      this.logger.log(
        `[MKT_TEST_CONTACTS_FINAL] count=${testPhones.length} phones=${JSON.stringify(testPhones)}`,
      );
    }
  }

  private static readonly STORE_URL = 'https://www.heshstore.in';

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
    @InjectRepository(ShopifyCatalogItem)
    private readonly catalogRepo: Repository<ShopifyCatalogItem>,
    @InjectRepository(MarketingCampaign)
    private readonly campaignRepo: Repository<MarketingCampaign>,
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

  // Reset daily sent counters at midnight IST
  @Cron('0 0 * * *', { timeZone: 'Asia/Kolkata' })
  async resetDailyCounters(): Promise<void> {
    this.logger.log('[Engine] Resetting daily sent counters at IST midnight');
    await this.numbersService.resetDailyCounts('cron_midnight_ist');
  }

  // Daily calibration at 7:00 AM: scores + cooldowns + template weights
  @Cron('0 7 * * *', { timeZone: 'Asia/Kolkata' })
  async refreshAudienceScores(): Promise<void> {
    this.logger.log('[Engine] Running daily calibration');
    await this.audienceAi.updateScores();
    await this.audienceAi.applyCooldowns();
    await this.templatesService.updatePerformanceWeights();
    this.logger.log('[Engine] Daily calibration complete');
  }

  // Build the day's queue at 8:30 AM
  @Cron('30 8 * * *', { timeZone: 'Asia/Kolkata' })
  async buildDailyQueue(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') {
      this.logger.warn(
        '[Engine] Disabled via WHATSAPP_ENGINE_ENABLED=false — skipping queue build',
      );
      return;
    }
    if (this._running) {
      this.logger.warn(
        '[Engine] buildDailyQueue already running — skipping re-entrant call',
      );
      return;
    }
    this._running = true;

    try {
      await this.numbersService.ensureDailyCountsReset();
      // Step 1: Ensure one autonomous campaign exists per connected telecaller number.
      // This must run before the queue build so every queue row gets a non-null campaign_id.
      const numberToCampaign = await this._ensureDailyCampaigns();

      // Step 2: Gate check — need at least one autonomous campaign OR a manually RUNNING campaign OR auto AI mode.
      const hasAutonomousCampaigns = numberToCampaign.size > 0;
      if (!hasAutonomousCampaigns) {
        const allCampaigns = await this.campaignsService.findAll();
        const hasRunning = allCampaigns.some(
          (c) => c.status === CampaignStatus.RUNNING,
        );
        if (!hasRunning) {
          const autoAiMode = await this.engineSettings.getAutoAiMode();
          if (!autoAiMode) {
            this.logger.warn(
              '[Engine] No autonomous campaigns, no running campaigns, auto AI mode OFF — skipping queue build',
            );
            return;
          }
          this.logger.log(
            '[Engine] No running campaigns — auto AI mode ON, building without per-number campaigns',
          );
        }
      }

      this.logger.log(
        `[Engine] Building daily queue — autonomous campaigns: ${numberToCampaign.size}`,
      );
      const result = await this._buildQueue(numberToCampaign);
      this.logger.log(
        `[Engine] Daily queue built: queued=${result.queued} connected=${result.connected_numbers} ` +
          `capacity=${result.daily_capacity} remaining=${result.remaining_capacity} ` +
          `eligible=${result.eligible_contacts} blocked=${result.blocked}`,
      );
      await this.auditService.log({
        event: AuditEvent.QUEUE_CREATED,
        reason: `Daily queue build: ${result.queued} items across ${result.connected_numbers} numbers`,
        metadata: result,
      });
    } finally {
      this._running = false;
    }
  }

  /**
   * Idempotent: for each connected WhatsApp number, ensures a RUNNING autonomous
   * promotion campaign exists for today. Creates one if missing.
   * Returns a map of numberId → campaignId for the daily campaigns.
   */
  async _ensureDailyCampaigns(): Promise<Map<string, string>> {
    const testOnly = process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true';
    const { start: today } = getIstDayBounds();

    const allNumbers = await this.numbersService.findAll();
    // Rule 6: create campaigns for ALL active numbers, not just currently-connected ones.
    // A number that is temporarily disconnected at 8:30 AM should still get a campaign
    // so it can be filled when it reconnects (via fillRemainingCapacity).
    const activeNumbers = allNumbers.filter(
      (n) => n.is_active && n.status === WhatsAppNumberStatus.ACTIVE,
    );

    if (!activeNumbers.length) {
      this.logger.warn(
        '[Engine] _ensureDailyCampaigns: no active numbers — skipping campaign creation',
      );
      return new Map();
    }

    // Find any existing autonomous campaigns for today (created since midnight)
    const existing = await this.campaignRepo.find({
      where: { is_promotion: true },
      order: { created_at: 'DESC' },
    });
    const todayExisting = existing.filter(
      (c) => c.telecaller_number_id && new Date(c.created_at) >= today,
    );
    const existingByNumber = new Map<string, string>(
      todayExisting.map((c) => [c.telecaller_number_id, c.id]),
    );

    const numberToCampaign = new Map<string, string>();

    for (const number of activeNumbers) {
      // T-index: extract trailing number from name "Telecaller N" → N.
      // This preserves stable naming across connection order changes.
      // Falls back to 0 if name has no trailing digit, which will produce PROMO-T0-... (logged as warning).
      const nameMatch = number.name?.match(/(\d+)\s*$/);
      const telecallerIndex = nameMatch ? parseInt(nameMatch[1], 10) : 0;
      if (!nameMatch) {
        this.logger.warn(
          `[ENGINE_CAMPAIGN] number=${number.phone} name="${number.name}" has no trailing digit — T-index will be 0`,
        );
      }

      // Already have today's campaign for this number
      if (existingByNumber.has(number.id)) {
        const campaignId = existingByNumber.get(number.id);
        numberToCampaign.set(number.id, campaignId);
        this.logger.log(
          `[ENGINE_CAMPAIGN] number=${number.phone} T${telecallerIndex} — today's campaign already exists id=${campaignId}`,
        );
        continue;
      }

      const promoId = CampaignsService.generateDailyPromoId(
        telecallerIndex,
        today,
      );
      const campaignName = `${promoId} · ${number.phone}`;

      const campaign = await this.campaignsService.create({
        campaign_name: campaignName,
        status: CampaignStatus.RUNNING,
        is_promotion: true,
        test_mode: false,
        telecaller_number_id: number.id,
        promo_id: promoId,
        notes: `Auto-created by autonomous engine for ${number.phone} (T${telecallerIndex})`,
      });

      numberToCampaign.set(number.id, campaign.id);
      await this.auditService.log({
        event: AuditEvent.QUEUE_CREATED,
        reason: `Autonomous campaign created: ${promoId} for number ${number.phone}`,
        metadata: {
          campaign_id: campaign.id,
          promo_id: promoId,
          number_phone: number.phone,
        },
      });
      this.logger.log(
        `[ENGINE_CAMPAIGN] created: promo_id=${promoId} id=${campaign.id} number=${number.phone} test_mode=false env_test_only=${testOnly}`,
      );
    }

    // Retroactive repair: link today's queue rows (campaign_id IS NULL) to their campaign.
    // This handles cases where the queue was built before campaign creation code was deployed.
    if (numberToCampaign.size > 0) {
      const repairFrom = today.toISOString();
      for (const [numberId, campaignId] of numberToCampaign) {
        const repaired = await this.campaignRepo.manager.query(
          `UPDATE whatsapp_message_queue
           SET campaign_id = $1
           WHERE number_id = $2 AND campaign_id IS NULL AND created_at >= $3
           RETURNING id`,
          [campaignId, numberId, repairFrom],
        );
        if (repaired.length > 0) {
          this.logger.log(
            `[ENGINE_CAMPAIGN_REPAIR] linked ${repaired.length} orphan queue rows → campaign=${campaignId} number=${numberId}`,
          );
        }
      }
    }

    return numberToCampaign;
  }

  /**
   * Create a validation campaign run for internal test contacts.
   * Audience: ONLY is_test_contact=true (opt_out+is_whatsapp_valid still apply).
   * Campaign naming: VALIDATION-YYYYMMDD-HHMMSS per connected number.
   * All customer-side restrictions (cooldown, fatigue, dedup) are bypassed
   * via isValidationContact(); production caps (daily/send-window) are NOT bypassed.
   */
  async runValidationCampaign(): Promise<{
    promo_id: string;
    campaigns: {
      campaign_id: string;
      number_phone: string;
      number_name: string | null;
    }[];
    audience_count: number;
    queued: number;
    numbers: number;
    cleanup: {
      campaigns_deleted: number;
      queue_rows_deleted: number;
      message_logs_deleted: number;
      audit_logs_deleted: number;
    };
  }> {
    const cleanup = await this._cleanupValidationArtifacts();
    this.logger.log(
      `[VALIDATION_CLEANUP] deleted campaigns=${cleanup.campaigns_deleted} ` +
        `queue_rows=${cleanup.queue_rows_deleted} message_logs=${cleanup.message_logs_deleted} ` +
        `audit_logs=${cleanup.audit_logs_deleted}`,
    );

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const promoId = `VALIDATION-${dateStr}-${hh}${mm}${ss}`;

    const allNumbers = await this.numbersService.findAll();
    const sendableNumbers = allNumbers.filter(
      (n) =>
        n.is_active &&
        n.status === WhatsAppNumberStatus.ACTIVE &&
        this.whatsAppService.getNumberState(n.id) ===
          NumberConnectionState.CONNECTED,
    );

    if (!sendableNumbers.length) {
      throw new BadRequestException(
        'No connected WhatsApp numbers — cannot run validation campaign',
      );
    }

    // ONLY test contacts; only hard safety rules apply (opt_out + is_whatsapp_valid)
    const allTestContacts = await this.audienceService.findTestContacts();
    const validationAudience = allTestContacts.filter(
      (c) => !c.opt_out && c.is_whatsapp_valid,
    );

    if (!validationAudience.length) {
      throw new BadRequestException(
        'No eligible validation contacts — set is_test_contact=true, opt_out=false, is_whatsapp_valid=true on at least one audience member',
      );
    }

    const numberToCampaign = new Map<string, string>();
    const createdCampaigns: {
      campaign_id: string;
      number_phone: string;
      number_name: string | null;
    }[] = [];

    for (const number of sendableNumbers) {
      const nameMatch = number.name?.match(/(\d+)\s*$/);
      const telecallerIndex = nameMatch ? parseInt(nameMatch[1], 10) : 0;

      const campaign = await this.campaignsService.create({
        campaign_name: `${promoId} · ${number.phone}`,
        status: CampaignStatus.RUNNING,
        is_promotion: true,
        test_mode: true, // always true — enables sender window bypass + 1h fingerprint window
        telecaller_number_id: number.id,
        promo_id: promoId,
        notes: `Validation campaign — T${telecallerIndex} · audience=test_contacts_only · bypass=cooldown,fatigue,dedup`,
      });

      numberToCampaign.set(number.id, campaign.id);
      createdCampaigns.push({
        campaign_id: campaign.id,
        number_phone: number.phone,
        number_name: number.name ?? null,
      });

      this.logger.log(
        `[VALIDATION_CAMPAIGN] created promo_id=${promoId} id=${campaign.id} number=${number.phone} T${telecallerIndex}`,
      );
    }

    await this.auditService.log({
      event: AuditEvent.QUEUE_CREATED,
      reason: `Validation campaign: ${promoId} — ${validationAudience.length} test contacts across ${sendableNumbers.length} numbers`,
      metadata: {
        promo_id: promoId,
        audience_count: validationAudience.length,
        numbers: sendableNumbers.length,
      },
    });

    // Pass validation audience directly — schedule immediately so sender picks up on next tick
    const result = await this._buildQueue(
      numberToCampaign,
      validationAudience,
      true,
    );

    this.logger.log(
      `[VALIDATION_CAMPAIGN] complete promo_id=${promoId} queued=${result.queued} numbers=${result.numbers}`,
    );

    return {
      promo_id: promoId,
      campaigns: createdCampaigns,
      audience_count: validationAudience.length,
      queued: result.queued,
      numbers: result.numbers,
      cleanup,
    };
  }

  /**
   * Deletes ONLY validation artifacts before a fresh validation run.
   *
   * Identification:
   *   - By campaign: promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
   *   - Orphaned queue rows (campaign_id=NULL): message_payload->>'is_validation' = 'true'
   *
   * Deletion order matters — message_logs references queue rows and campaigns, so it
   * must be deleted first while the subqueries can still resolve.
   *
   * NOT touched: whatsapp_replies, promotion_product_rotation, leads.
   */
  private async _cleanupValidationArtifacts(): Promise<{
    campaigns_deleted: number;
    queue_rows_deleted: number;
    message_logs_deleted: number;
    audit_logs_deleted: number;
  }> {
    const campaignRows = await this.ds.query<{ id: string }[]>(
      `SELECT id FROM marketing_campaigns
       WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'`,
    );

    if (!campaignRows.length) {
      return {
        campaigns_deleted: 0,
        queue_rows_deleted: 0,
        message_logs_deleted: 0,
        audit_logs_deleted: 0,
      };
    }

    // Step 1: Delete message logs FIRST (references queue rows + campaigns via subquery).
    // Catches both directly-linked rows (campaign_id) and indirectly-linked rows (queue_id).
    const deletedLogs = await this.ds.query<{ id: string }[]>(`
      DELETE FROM whatsapp_message_logs
      WHERE campaign_id IN (
              SELECT id FROM marketing_campaigns
              WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
            )
         OR queue_id IN (
              SELECT id FROM whatsapp_message_queue
              WHERE campaign_id IN (
                      SELECT id FROM marketing_campaigns
                      WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
                    )
                 OR (message_payload->>'is_validation')::boolean = true
            )
      RETURNING id
    `);

    // Step 2: Delete queue rows + audit logs in parallel.
    // Queue: by campaign_id AND by the is_validation JSONB flag to catch NULL-campaign_id orphans.
    const [deletedQueue, deletedAudit] = await Promise.all([
      this.ds.query<{ id: string }[]>(`
        DELETE FROM whatsapp_message_queue
        WHERE campaign_id IN (
                SELECT id FROM marketing_campaigns
                WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
              )
           OR (message_payload->>'is_validation')::boolean = true
        RETURNING id
      `),
      this.ds.query<{ id: string }[]>(`
        DELETE FROM engine_audit_logs
        WHERE campaign_id IN (
                SELECT id FROM marketing_campaigns
                WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
              )
        RETURNING id
      `),
    ]);

    // Step 3: Delete campaigns last.
    await this.ds.query(`
      DELETE FROM marketing_campaigns
      WHERE promo_id LIKE 'VALIDATION-%' OR campaign_name LIKE 'VALIDATION-%'
    `);

    return {
      campaigns_deleted: campaignRows.length,
      queue_rows_deleted: deletedQueue.length,
      message_logs_deleted: deletedLogs.length,
      audit_logs_deleted: deletedAudit.length,
    };
  }

  async _buildQueue(
    numberToCampaign: Map<string, string> = new Map(),
    audienceOverride?: MarketingAudience[],
    scheduleImmediately = false,
  ): Promise<{
    queued: number;
    numbers: number;
    connected_numbers: number;
    daily_capacity: number;
    remaining_capacity: number;
    eligible_contacts: number;
    blocked: number;
  }> {
    this.logger.log(
      `[MKT_QUEUE_GATE] _buildQueue start — engine_enabled=${process.env.WHATSAPP_ENGINE_ENABLED} ` +
        `test_only=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW} ` +
        `autonomous_campaigns=${numberToCampaign.size}`,
    );

    await this.numbersService.ensureDailyCountsReset();

    const allNumbers = await this.numbersService.findAll();
    // Only connected numbers can receive queue items.
    // NumberConnectionState is the single source of truth. DB wa_state and UI both derive from it.
    const sendableNumbers = allNumbers.filter(
      (n) =>
        n.is_active &&
        n.status === WhatsAppNumberStatus.ACTIVE &&
        this.whatsAppService.getNumberState(n.id) ===
          NumberConnectionState.CONNECTED,
    );

    this.logger.log(
      `[MKT_QUEUE_GATE] numbers: total=${allNumbers.length} connected=${sendableNumbers.length} ` +
        `planning=${sendableNumbers.map((n) => `${n.phone}:L${n.warmup_level} release=${getReleaseAllowance(n.warmup_level)} queue_cap=${getMatureDailyCapacity()}`).join(' ')}`,
    );
    if (!sendableNumbers.length) {
      this.logger.warn(
        '[MKT_QUEUE_GATE] reason=no_connected_numbers — zero sendable numbers; skipping build',
      );
      return {
        queued: 0,
        numbers: 0,
        connected_numbers: 0,
        daily_capacity: 0,
        remaining_capacity: 0,
        eligible_contacts: 0,
        blocked: 0,
      };
    }

    // Queue planning uses mature capacity (150/number). Sender enforces release allowance by warmup stage.
    const matureCap = getMatureDailyCapacity();
    const { start: todayStart } = getIstDayBounds();
    const todayRows: { number_id: string; cnt: string }[] = await this.ds.query(
      `SELECT number_id, COUNT(*) AS cnt FROM whatsapp_message_queue WHERE created_at >= $1 AND number_id IS NOT NULL GROUP BY number_id`,
      [todayStart],
    );
    const queuedTodayByNumber = new Map(
      todayRows.map((r) => [r.number_id, parseInt(r.cnt, 10)]),
    );

    const daily_capacity = sendableNumbers.length * matureCap;
    const remaining_capacity = sendableNumbers.reduce((sum, n) => {
      const queued = queuedTodayByNumber.get(n.id) ?? 0;
      return sum + Math.max(0, matureCap - queued);
    }, 0);

    this.logger.log(
      `[MKT_QUEUE_CAPACITY] connected=${sendableNumbers.length} daily_capacity=${daily_capacity} ` +
        `remaining=${remaining_capacity}`,
    );

    if (remaining_capacity === 0) {
      this.logger.log(
        '[MKT_QUEUE_GATE] Daily capacity exhausted for all numbers — nothing to queue',
      );
      return {
        queued: 0,
        numbers: sendableNumbers.length,
        connected_numbers: sendableNumbers.length,
        daily_capacity,
        remaining_capacity: 0,
        eligible_contacts: 0,
        blocked: 0,
      };
    }

    // Dedup: skip phones already queued today (any status)
    const activePhones = await this.queueService.findActivePhonesSet();
    this.logger.log(
      `[MKT_QUEUE_GATE] active_queue_phones=${activePhones.size}`,
    );

    const rawAudience =
      audienceOverride ?? (await this.audienceAi.filterByQuality(30));
    // Build queue for full eligible audience — release allowance is enforced by sender only.
    const audience = rawAudience;
    this.logger.log(
      `[MKT_QUEUE_GATE] audience: raw=${rawAudience.length} capacity=${remaining_capacity} override=${!!audienceOverride}`,
    );
    if (!audience.length) {
      this.logger.warn(
        '[MKT_QUEUE_SKIP_REASON] No eligible audience — skipping build',
      );
      return {
        queued: 0,
        numbers: sendableNumbers.length,
        connected_numbers: sendableNumbers.length,
        daily_capacity,
        remaining_capacity,
        eligible_contacts: 0,
        blocked: 0,
      };
    }

    const allTemplates = await this.templatesService.findAll();
    const activeTemplates = allTemplates.filter(
      (t) => t.is_active && t.template_mode === TemplateMode.AI,
    );

    this.logger.log(
      `[MKT_QUEUE_GATE] templates: total=${allTemplates.length} active_ai=${activeTemplates.length}`,
    );
    if (!activeTemplates.length) {
      this.logger.warn(
        '[MKT_QUEUE_SKIP_REASON] No active AI-mode templates — skipping build',
      );
      return {
        queued: 0,
        numbers: sendableNumbers.length,
        connected_numbers: sendableNumbers.length,
        daily_capacity,
        remaining_capacity,
        eligible_contacts: audience.length,
        blocked: audience.length,
      };
    }

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

    const existingTodayCounts = runningCampaignIds.length
      ? await this.queueService.countTodayByCampaign(runningCampaignIds)
      : new Map<string, number>();
    const addedThisRunByCampaign = new Map<string, number>();

    this.logger.log(
      `[MKT_QUEUE_INPUT] audience=${audience.length} templates=${activeTemplates.length} ` +
        `connected_numbers=${sendableNumbers.map((n) => n.phone).join(',')}`,
    );

    const items: Partial<WhatsappMessageQueue>[] = [];
    // Rule 2: track per-number allocations from this run independently
    const allocatedPerNumber: Record<string, number> = {};
    for (const n of sendableNumbers) allocatedPerNumber[n.id] = 0;
    let numberCursor = 0;

    const MAX_CATEGORY_SHARE = 0.4;
    const categoryCount: Record<string, number> = {};

    for (const member of audience) {
      // Capacity-aware round-robin: every connected number gets its own independent queue.
      let number: (typeof sendableNumbers)[0] | null = null;
      for (let i = 0; i < sendableNumbers.length; i++) {
        const candidate =
          sendableNumbers[(numberCursor + i) % sendableNumbers.length];
        const queued = queuedTodayByNumber.get(candidate.id) ?? 0;
        if (queued + (allocatedPerNumber[candidate.id] ?? 0) < matureCap) {
          number = candidate;
          numberCursor = (numberCursor + i + 1) % sendableNumbers.length;
          break;
        }
      }
      if (!number) break; // all numbers at capacity

      if (activePhones.has(member.phone)) {
        this.logger.log(
          `[MKT_QUEUE_SKIP_DUPE] phone=${member.phone} already in today's queue — skipping`,
        );
        continue;
      }

      const template = this._balancedTemplate(
        activeTemplates,
        categoryCount,
        audience.length,
        MAX_CATEGORY_SHARE,
      );
      if (!template) continue;

      const campaignId = templateToCampaign.get(template.id) ?? null;

      if (campaignId && campaignDailyTargets.has(campaignId)) {
        const target = campaignDailyTargets.get(campaignId);
        const existing = existingTodayCounts.get(campaignId) ?? 0;
        const added = addedThisRunByCampaign.get(campaignId) ?? 0;
        if (existing + added >= target) {
          this.logger.log(
            `[MKT_QUEUE_SKIP_CAP] campaign_id=${campaignId} target=${target} existingToday=${existing} addedThisRun=${added} phone=${member.phone}`,
          );
          continue;
        }
      }

      const scheduledAt = scheduleImmediately
        ? new Date()
        : await this.timingAi.getOptimalSendTime(member.phone);

      const resolvedCampaignId = numberToCampaign.get(number.id) ?? campaignId;
      const catalogItem = resolvedCampaignId
        ? (campaignToProduct.get(resolvedCampaignId) ?? null)
        : null;

      const productFields = catalogItem
        ? {
            product_name: catalogItem.itemName ?? '',
            product_sku: catalogItem.sku ?? '',
            product_image: catalogItem.image ?? '',
            product_link: AutonomousEngineService.STORE_URL,
          }
        : {};

      items.push({
        campaign_id: resolvedCampaignId,
        number_id: number.id,
        product_id: catalogItem?.id ?? undefined,
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
          sender_phone: number.phone,
          is_validation: isValidationContact(member),
          ...productFields,
        },
      });
      this.logger.log(
        `[MKT_QUEUE_ITEM] phone=${member.phone} template="${template.template_name}" number=${number.phone} ` +
          `campaign_id=${resolvedCampaignId ?? 'none'} scheduled_at=${scheduledAt.toISOString()}`,
      );

      if (campaignId)
        addedThisRunByCampaign.set(
          campaignId,
          (addedThisRunByCampaign.get(campaignId) ?? 0) + 1,
        );

      const cat = template.product_category ?? 'general';
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
      allocatedPerNumber[number.id]++;
    }

    const queued = await this.queueService.bulkEnqueue(items);
    if (queued > 0) {
      this.logger.log(
        `[MKT_QUEUE_CREATED] queued=${queued} phones=${JSON.stringify(items.map((i) => i.customer_phone))}`,
      );
    }

    for (const [cid, added] of addedThisRunByCampaign) {
      this.logger.log(
        `[MKT_QUEUE_BUILD] campaignId=${cid} existingToday=${existingTodayCounts.get(cid) ?? 0} newRows=${added}`,
      );
    }

    const blocked = audience.length - queued;
    // Rule 7: structured output
    this.logger.log(
      `[MKT_QUEUE_RESULT] connected_numbers=${sendableNumbers.length} daily_capacity=${daily_capacity} ` +
        `remaining_capacity=${remaining_capacity} eligible_contacts=${audience.length} ` +
        `queued=${queued} blocked=${blocked}`,
    );
    return {
      queued,
      numbers: sendableNumbers.length,
      connected_numbers: sendableNumbers.length,
      daily_capacity,
      remaining_capacity,
      eligible_contacts: audience.length,
      blocked,
    };
  }

  /**
   * Rule 3: fill remaining today's capacity with newly eligible contacts.
   * Called automatically after bulk audience import so late-imported contacts
   * are queued immediately without waiting for tomorrow's 8:30 AM cron.
   * Idempotent — dedup in _buildQueue prevents double-queuing.
   */
  async fillRemainingCapacity(): Promise<{ queued: number; numbers: number }> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false')
      return { queued: 0, numbers: 0 };
    // TEST_ONLY gate removed: filterByQuality(30) inside _buildQueue already excludes
    // test contacts via `is_test_contact IS NOT TRUE`, so test contacts cannot enter
    // the autonomous queue regardless of the TEST_ONLY env flag.

    this.logger.log(
      '[Engine] fillRemainingCapacity triggered — checking for remaining daily capacity',
    );
    const numberToCampaign = await this._ensureDailyCampaigns();
    const result = await this._buildQueue(numberToCampaign);
    this.logger.log(
      `[Engine] fillRemainingCapacity: queued=${result.queued} remaining=${result.remaining_capacity}`,
    );
    return { queued: result.queued, numbers: result.numbers };
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

    const totalWeight = pool.reduce(
      (sum, t) => sum + (Number(t.performance_weight) || 1.0),
      0,
    );
    let rand = Math.random() * totalWeight;
    for (const t of pool) {
      rand -= Number(t.performance_weight) || 1.0;
      if (rand <= 0) return t;
    }
    return pool[pool.length - 1] ?? null;
  }
}

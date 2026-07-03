import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import {
  CTAType,
  MessageType,
  QueueStatus,
  TemplateMode,
} from '../entities/enums';
import { QueueService } from '../queue/queue.service';
import { TemplatesService } from '../templates/templates.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { MessageAiService } from '../ai/message-ai.service';
import { NumbersService } from '../numbers/numbers.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineAuditService, AuditEvent } from '../engine/engine-audit.service';
import { AudienceService } from '../audience/audience.service';
import { PromotionProductSelectionService } from '../promotion/promotion-product-selection.service';
import { PromotionAiTemplateService } from '../promotion/promotion-ai-template.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { buildCta } from '../shared/cta-builder';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { getReleaseAllowance } from '../shared/number-limits';
import { NumberConnectionState } from '../shared/number-state';
import { normalizeSkipReason, SkipReason } from '../shared/skip-reason';

const CONTENT_FINGERPRINT_DAYS = 3;
// Test-mode campaigns use a 1-hour window so the same template can be resent quickly
// during QA. Production behavior (3 days) is unaffected.
const CONTENT_FINGERPRINT_HOURS_TEST = 1;

// AI promo hardening constants
const MAX_PRODUCT_ATTEMPTS = 2; // max distinct products tried per send before giving up
const PRODUCT_CUSTOMER_COOLDOWN_DAYS = 7; // same customer + same SKU cooldown window

// Human-like inter-send delay: 30s–5min; 10% chance of 15–30min idle window
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 5 * 60_000;
const IDLE_PROB = 0.1;
const MIN_IDLE_MS = 15 * 60_000;
const MAX_IDLE_MS = 30 * 60_000;

function humanDelay(): number {
  if (Math.random() < IDLE_PROB) {
    return MIN_IDLE_MS + Math.random() * (MAX_IDLE_MS - MIN_IDLE_MS);
  }
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Strip all non-digits and leading zeros — used only for comparisons, never stored.
function normalizePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '').replace(/^0+/, '');
}

// True when both TEST_ONLY and BYPASS env flags are set — disables all human delay logic.
function isTestBypassMode(): boolean {
  return (
    process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true' &&
    process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true'
  );
}

@Injectable()
export class SenderService implements OnModuleInit {
  private readonly logger = new Logger(SenderService.name);
  private _tickSelecting = false;
  private readonly _numberLocks = new Map<string, boolean>();
  private readonly _nextAllowedSendByNumber = new Map<string, Date>();
  private _idleUntil = 0; // epoch ms — skip DB queries until this timestamp

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(WhatsappMessageLog)
    private logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(MarketingAudience)
    private audienceRepo: Repository<MarketingAudience>,
    private readonly queueService: QueueService,
    private readonly templatesService: TemplatesService,
    private readonly timingAi: TimingAiService,
    private readonly messageAi: MessageAiService,
    private readonly numbersService: NumbersService,
    private readonly whatsAppService: MarketingWhatsAppService,
    private readonly auditService: EngineAuditService,
    private readonly audienceService: AudienceService,
    private readonly promotionProductService: PromotionProductSelectionService,
    private readonly promotionAiService: PromotionAiTemplateService,
    private readonly campaignsService: CampaignsService,
  ) {
    this.logger.log(
      '[MKT_SENDER_CONSTRUCTED] SenderService constructor called',
    );
  }

  onModuleInit(): void {
    this.logger.log(
      `[MKT_SENDER_BOOT] SenderService onModuleInit — ` +
        `engine_enabled=${process.env.WHATSAPP_ENGINE_ENABLED} ` +
        `test_only=${process.env.WHATSAPP_ENGINE_TEST_ONLY} ` +
        `bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );
    this.logger.log(
      '[MKT_SENDER_CRON_REGISTERED] @Interval(15s) is the sole tick source',
    );
  }

  private _isNumberLocked(numberId: string): boolean {
    return this._numberLocks.get(numberId) === true;
  }

  private _lockNumber(numberId: string): void {
    this._numberLocks.set(numberId, true);
  }

  private _unlockNumber(numberId: string): void {
    this._numberLocks.set(numberId, false);
  }

  private _nextAllowedSend(numberId: string): Date {
    return this._nextAllowedSendByNumber.get(numberId) ?? new Date(0);
  }

  private _setNextAllowedSend(numberId: string): void {
    this._nextAllowedSendByNumber.set(
      numberId,
      new Date(Date.now() + humanDelay()),
    );
  }

  @Interval(15_000)
  async tick(): Promise<void> {
    const connected = this.whatsAppService.isAnyConnected();
    const enabled = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    const inWindow = this.timingAi.isWithinSendWindow();
    const testBypass = isTestBypassMode();
    const lockedNumbers = [...this._numberLocks.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k);
    const delayedNumbers = [...this._nextAllowedSendByNumber.entries()]
      .filter(([, dt]) => dt.getTime() > Date.now())
      .map(([numberId, dt]) => ({
        numberId,
        nextAllowedSend: dt.toISOString(),
      }));

    this.logger.log(
      `[MKT_SENDER_TICK] enabled=${enabled} connected=${connected} ` +
        `inWindow=${inWindow} lockedNumbers=${JSON.stringify(lockedNumbers)} ` +
        `delayedNumbers=${JSON.stringify(delayedNumbers)} ` +
        `testOnly=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );
    this.logger.log(
      `[MKT_DELAY_DEBUG] now=${new Date().toISOString()} ` +
        `delayedNumbers=${JSON.stringify(delayedNumbers)} ` +
        `source=${testBypass ? 'bypassed_test_mode' : 'per_number_delay'}`,
    );

    if (!enabled) {
      this.logger.log('[MKT_SENDER_TICK_SKIP] reason=engine_disabled');
      this.logger.warn(
        '[SENDER_AUDIT] tick_blocked: reason=WHATSAPP_ENGINE_ENABLED=false',
      );
      return;
    }
    if (this._tickSelecting) {
      this.logger.log('[MKT_SENDER_TICK_SKIP] reason=tick_selecting');
      return;
    }
    if (!connected) {
      this.logger.log(
        '[MKT_SENDER_TICK_SKIP] reason=no_wa_connection — waiting for client ready',
      );
      this.logger.warn(
        '[SENDER_AUDIT] tick_blocked: reason=no_connected_wa_number',
      );
      return;
    }

    // Idle backoff: after an empty queue result, skip all three DB queries until
    // _idleUntil expires (30 s on first empty, 60 s on subsequent empties).
    // Resets to 0 the moment work is found so active campaigns see no added latency.
    if (Date.now() < this._idleUntil) {
      this.logger.log(
        `[MKT_SENDER_TICK_SKIP] reason=idle_backoff idleUntil=${new Date(this._idleUntil).toISOString()}`,
      );
      return;
    }

    // Window check: outside business hours blocks live sends but not test_mode campaigns.
    let windowBypassed = false;
    if (!inWindow) {
      const testPending = await this.queueService.findTestModePending(1);
      if (!testPending.length) {
        this.logger.log(
          `[MKT_SENDER_TICK_SKIP] reason=outside_send_window bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
        );
        return;
      }
      windowBypassed = true;
      this.logger.log(
        `[PROMOTION_TEST_MODE_WINDOW_BYPASS] campaignId=${testPending[0].campaign_id} reason=test_mode`,
      );
    }

    this.logger.log(
      `[MKT_SCHEDULER_TICK] inWindow=${inWindow} windowBypassed=${windowBypassed} ` +
        `testOnly=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );

    // ── Selection phase (TOCTOU-safe) ────────────────────────────────────────
    // _tickSelecting serializes fetch+select+lock so two concurrent @Interval firings
    // cannot race to claim the same pending item before either calls markProcessing.
    this._tickSelecting = true;
    const assignments: {
      item: WhatsappMessageQueue;
      number: WhatsappNumber;
    }[] = [];

    try {
      this.logger.log(
        `[MKT_SENDER_QUEUE_PATH] windowBypassed=${windowBypassed} inWindow=${inWindow} ` +
          `using=${windowBypassed ? 'findNextPendingForNumber(test)' : 'findNextPendingForNumber'} ` +
          `testBypass=${testBypass}`,
      );

      const allNumbers = await this.numbersService.findAll();
      this.logger.log(
        `[MKT_POOL_STAGE_1] total=${allNumbers.length} ` +
          `numbers=${JSON.stringify(
            allNumbers.map((n) => ({
              id: n.id,
              phone: n.phone,
              is_active: n.is_active,
              status: n.status,
              number_state: this.whatsAppService.getNumberState(n.id),
              wa_state: n.wa_state,
              daily_sent: n.daily_sent,
              db_daily_limit: n.daily_limit,
              release_allowance: getReleaseAllowance(n.warmup_level),
              warmup_level: n.warmup_level,
            })),
          )}`,
      );

      const eligibleNumbers: WhatsappNumber[] = [];
      for (const n of allNumbers) {
        const releaseAllowance = getReleaseAllowance(n.warmup_level);
        const diag = this.whatsAppService.getConnectionDiagnostics(n.id);
        if (!n.is_active) {
          this.logger.log(
            `[MKT_POOL_DROP] id=${n.id} phone=${n.phone} reason=is_active=false`,
          );
          continue;
        }
        if (
          this.whatsAppService.getNumberState(n.id) !==
          NumberConnectionState.CONNECTED
        ) {
          this.logger.log(
            `[MKT_POOL_DROP] id=${n.id} phone=${n.phone} reason=number_state_${diag.numberState} ` +
              `waState=${diag.waState} pageOpen=${diag.pageOpen} browserConnected=${diag.browserConnected}`,
          );
          continue;
        }
        if (n.daily_sent >= releaseAllowance) {
          this.logger.log(
            `[MKT_POOL_DROP] id=${n.id} phone=${n.phone} reason=release_allowance_exhausted ` +
              `daily_sent=${n.daily_sent} release_allowance=${releaseAllowance} warmup_level=${n.warmup_level}`,
          );
          continue;
        }
        if (this._isNumberLocked(n.id)) {
          this.logger.log(
            `[MKT_POOL_DROP] id=${n.id} phone=${n.phone} reason=number_locked`,
          );
          continue;
        }
        const nextAllowed = this._nextAllowedSend(n.id);
        if (!testBypass && nextAllowed.getTime() > Date.now()) {
          this.logger.log(
            `[MKT_POOL_DROP] id=${n.id} phone=${n.phone} reason=per_number_delay until=${nextAllowed.toISOString()}`,
          );
          continue;
        }
        eligibleNumbers.push(n);
      }
      this.logger.log(
        `[MKT_POOL_ELIGIBLE] count=${eligibleNumbers.length} phones=${JSON.stringify(eligibleNumbers.map((n) => n.phone))}`,
      );

      for (const number of eligibleNumbers) {
        const item = await this.queueService.findNextPendingForNumber(
          number.id,
          windowBypassed,
        );
        if (!item) {
          this.logger.log(
            `[MKT_NUMBER_QUEUE_EMPTY] numberId=${number.id} phone=${number.phone}`,
          );
          continue;
        }
        assignments.push({ item, number });
        this._lockNumber(number.id);
        this.logger.log(
          `[MKT_NUMBER_LOCK_ACQUIRED] numberId=${number.id} phone=${number.phone} queueId=${item.id}`,
        );
      }

      if (!assignments.length) {
        // 1st empty → 30 s backoff; subsequent empties → 60 s (already past the 30 s gap).
        const backoff = this._idleUntil > 0 ? 60_000 : 30_000;
        this._idleUntil = Date.now() + backoff;
        this.logger.log(
          `[MKT_SENDER_TICK_SKIP] reason=no_per_number_pending_items ` +
            `backoffMs=${backoff} idleUntil=${new Date(this._idleUntil).toISOString()}`,
        );
        this.logger.log(
          '[SENDER_AUDIT] tick_result: queue_empty_for_eligible_numbers',
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[MKT_SCHEDULER_FATAL] tick selection crashed: ${err?.message}\n${err?.stack}`,
      );
    } finally {
      this._tickSelecting = false;
    }

    if (!assignments.length) return;

    this._idleUntil = 0;

    await Promise.allSettled(
      assignments.map(async ({ item, number }) => {
        this.logger.log(
          `[MKT_QUEUE_ITEM_PROCESS] id=${item.id} phone=${item.customer_phone} ` +
            `template_id=${item.template_id ?? 'none'} scheduled_at=${item.scheduled_at?.toISOString()}`,
        );
        try {
          await this.processNext(item, number);
        } catch (err: any) {
          this.logger.error(
            `[MKT_SCHEDULER_FATAL] tick crashed: ${err?.message}\n${err?.stack}`,
          );
        } finally {
          this._unlockNumber(number.id);
          this.logger.log(
            `[MKT_NUMBER_LOCK_RELEASED] numberId=${number.id} phone=${number.phone} queueId=${item.id}`,
          );
        }
      }),
    );
  }

  // Outer shell: guarantees [MKT_PROCESS_COMPLETE] fires regardless of outcome.
  // After _processNextInternal returns (item is in a terminal state), trigger
  // campaign completion evaluation if the item belonged to a campaign.
  async processNext(
    item: WhatsappMessageQueue,
    preselectedNumber?: WhatsappNumber,
  ): Promise<void> {
    this.logger.log(
      `[MKT_PROCESS_START] id=${item.id} phone=${item.customer_phone} ` +
        `template_id=${item.template_id ?? 'none'} campaign_id=${item.campaign_id ?? 'none'} ` +
        `number_id=${item.number_id ?? 'none'} scheduled_at=${item.scheduled_at?.toISOString()}`,
    );
    try {
      await this._processNextInternal(item, preselectedNumber);
    } finally {
      this.logger.log(
        `[MKT_PROCESS_COMPLETE] id=${item.id} phone=${item.customer_phone}`,
      );
      if (item.campaign_id) {
        this.campaignsService
          .evaluateCompletion(item.campaign_id)
          .catch((e: any) => {
            this.logger.warn(
              `[CAMPAIGN_COMPLETION_FAIL] campaignId=${item.campaign_id} error="${e?.message}"`,
            );
          });
      }
    }
  }

  private async _processNextInternal(
    item: WhatsappMessageQueue,
    preselectedNumber?: WhatsappNumber,
  ): Promise<void> {
    await this.queueService.markProcessing(item.id);

    // logRow is written before any send attempt — guarantees DB visibility even on crash
    let logRow: WhatsappMessageLog | null = null;

    try {
      // Reject cross-tier preselection — queue owner must equal actual sender.
      if (
        preselectedNumber &&
        item.number_id &&
        preselectedNumber.id !== item.number_id
      ) {
        this.logger.warn(
          `[MKT_SENDER_TIER_VIOLATION] queue_id=${item.id} assigned=${item.number_id} ` +
            `preselected=${preselectedNumber.id} — deferring`,
        );
        await this.queueService.markDeferred(
          item.id,
          SkipReason.ASSIGNED_SENDER_UNAVAILABLE,
        );
        this.logger.log(
          `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=deferred_pending failure_reason="ASSIGNED_SENDER_UNAVAILABLE"`,
        );
        return;
      }
      // ── Gate: campaign test_mode — validation campaigns only send to test contacts ─
      // Driven by campaign.test_mode, NOT the env var. This decouples validation mode
      // from autonomous mode: autonomous campaigns have test_mode=false and send to all
      // eligible promotional contacts; validation campaigns have test_mode=true and are
      // restricted to is_test_contact=true phones.
      const campaignTestMode = item.campaign_id
        ? (
            await this.campaignsService
              .findOne(item.campaign_id)
              .catch(() => null)
          )?.test_mode === true
        : false;
      if (campaignTestMode) {
        const testPhones = await this.audienceService.getTestPhones();
        const normalizedQueue = normalizePhone(item.customer_phone);
        const normalizedTestPhones = testPhones.map(normalizePhone);
        const matched = normalizedTestPhones.includes(normalizedQueue);
        this.logger.log(
          `[MKT_TEST_CONTACT_MATCH] phone=${item.customer_phone} testPhones=${JSON.stringify(testPhones)} matched=${matched}`,
        );
        this.logger.log(
          `[MKT_TEST_CONTACT_NORMALIZED] queuePhone=${normalizedQueue} matched=${matched}`,
        );
        if (!matched) {
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
              `rule=CAMPAIGN_TEST_MODE reason="not a test contact" condition_values="campaign_id=${item.campaign_id} testPhones=${JSON.stringify(testPhones)}"`,
          );
          await this.queueService.markSkipped(
            item.id,
            SkipReason.CUSTOMER_PROTECTED,
          );
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="CAMPAIGN_TEST_MODE: not a test contact"`,
          );
          return;
        }
      }

      // ── Gate: sender pool selection ─────────────────────────────────────────
      // If tick pre-selected a number (lock already acquired), use it directly.
      // Otherwise build the pool from scratch (manual / non-tick callers).
      let number: WhatsappNumber | null = preselectedNumber ?? null;

      if (!number) {
        const allNumbers = await this.numbersService.findAll();
        // DB wa_state can lag; NumberConnectionState is the authoritative connection check.
        const eligibleNumbers = allNumbers.filter((n) => {
          if (!n.is_active) return false;
          if (
            this.whatsAppService.getNumberState(n.id) !==
            NumberConnectionState.CONNECTED
          )
            return false;
          return n.daily_sent < getReleaseAllowance(n.warmup_level);
        });

        this.logger.log(
          `[MKT_SENDER_POOL] queue_id=${item.id} total=${allNumbers.length} ` +
            `eligible=${eligibleNumbers.length} numbers=[${eligibleNumbers.map((n) => n.phone).join(',')}]`,
        );

        if (!item.number_id) {
          await this.queueService.markDeferred(
            item.id,
            SkipReason.ASSIGNED_SENDER_UNAVAILABLE,
          );
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=deferred_pending failure_reason="ASSIGNED_SENDER_UNAVAILABLE"`,
          );
          return;
        }

        number = eligibleNumbers.find((n) => n.id === item.number_id) ?? null;
        if (!number) {
          this.logger.warn(
            `[MKT_SENDER_DEFER] queue_id=${item.id} phone=${item.customer_phone} ` +
              `assigned_number_id=${item.number_id} reason=ASSIGNED_SENDER_UNAVAILABLE ` +
              `eligible_count=${eligibleNumbers.length}`,
          );
          await this.queueService.markDeferred(
            item.id,
            SkipReason.ASSIGNED_SENDER_UNAVAILABLE,
          );
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=deferred_pending failure_reason="ASSIGNED_SENDER_UNAVAILABLE"`,
          );
          return;
        }

        this.logger.log(
          `[MKT_SENDER_SELECTED] queue_id=${item.id} number=${number.phone} ` +
            `number_id=${number.id} daily_sent=${number.daily_sent} reason=assigned_only`,
        );
      } else {
        this.logger.log(
          `[MKT_SENDER_POOL] queue_id=${item.id} total=1 eligible=1 numbers=[${number.phone}]`,
        );
        this.logger.log(
          `[MKT_SENDER_SELECTED] queue_id=${item.id} number=${number.phone} ` +
            `number_id=${number.id} daily_sent=${number.daily_sent} reason=preselected_locked`,
        );
      }

      // Persist actual sender immediately — before any further gates — so every
      // queue outcome (SENT / SKIPPED / FAILED / DEFERRED) carries sender traceability.
      await this.queueService.assignSender(
        item.id,
        number.id,
        number.phone,
        number.name,
      );

      this.logger.log(
        `[MKT_DAILY_CAP_ONLY] queue_id=${item.id} number_id=${number.id} ` +
          `warmup=${number.warmup_level} daily_sent=${number.daily_sent} release_allowance=${getReleaseAllowance(number.warmup_level)}`,
      );

      // ── Gate: content fingerprint ────────────────────────────────────────────
      // AI templates generate unique content per send — fingerprint by template_id is meaningless.
      const isAiTemplate = item.template_id
        ? (
            await this.templatesService
              .findOne(item.template_id)
              .catch(() => null)
          )?.template_mode === TemplateMode.AI
        : false;

      // Validation contacts (is_test_contact=true, propagated via message_payload.is_validation)
      // bypass the fingerprint gate entirely — they must always be sendable for validation runs.
      const isValidation =
        (item.message_payload as any)?.is_validation === true;

      if (item.template_id && !isAiTemplate && !isValidation) {
        // Test-mode campaigns use a 1-hour lookback so the same template can be resent
        // during QA without waiting 3 days. Production behavior is unchanged.
        const isTestCampaign = item.campaign_id
          ? (
              await this.campaignsService
                .findOne(item.campaign_id)
                .catch(() => null)
            )?.test_mode === true
          : false;
        const windowMs = isTestCampaign
          ? CONTENT_FINGERPRINT_HOURS_TEST * 3600 * 1000
          : CONTENT_FINGERPRINT_DAYS * 24 * 3600 * 1000;
        const fingerprintCutoff = new Date(Date.now() - windowMs);

        this.logger.log(
          `[MKT_FINGERPRINT_WINDOW] queue_id=${item.id} test_mode=${isTestCampaign} ` +
            `window=${isTestCampaign ? `${CONTENT_FINGERPRINT_HOURS_TEST}h` : `${CONTENT_FINGERPRINT_DAYS}d`} ` +
            `cutoff=${fingerprintCutoff.toISOString()}`,
        );

        const recentSame = await this.logRepo
          .createQueryBuilder('l')
          .where('l.customer_phone = :phone', { phone: item.customer_phone })
          .andWhere('l.sent_at >= :cutoff', { cutoff: fingerprintCutoff })
          .andWhere(
            `EXISTS (
              SELECT 1 FROM whatsapp_message_queue q
              WHERE q.id = l.queue_id AND q.template_id = :tid
            )`,
            { tid: item.template_id },
          )
          .getCount();

        if (recentSame > 0) {
          const windowLabel = isTestCampaign
            ? `${CONTENT_FINGERPRINT_HOURS_TEST} hour`
            : `${CONTENT_FINGERPRINT_DAYS} days`;
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
              `rule=CONTENT_FINGERPRINT reason="same template sent within ${windowLabel}" ` +
              `condition_values="template_id=${item.template_id} recent_matches=${recentSame} test_mode=${isTestCampaign}"`,
          );
          await this.queueService.markSkipped(
            item.id,
            SkipReason.COOLDOWN_ACTIVE,
          );
          await this.auditService.log({
            event: AuditEvent.FINGERPRINT_SKIP,
            number_id: item.number_id ?? undefined,
            customer_phone: item.customer_phone,
            template_id: item.template_id,
            reason: `Template already sent to this phone within ${windowLabel}`,
          });
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="FINGERPRINT: template_id=${item.template_id}"`,
          );
          return;
        }
      }

      // ── Resolve body + image ─────────────────────────────────────────────────
      const { body, imageUrl: resolvedImageUrl } = await this._resolveBody(
        item,
        number?.phone ?? undefined,
        number?.id ?? undefined,
      );
      if (body === null) {
        this.logger.warn(
          `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=NO_BODY reason="no usable message body" ` +
            `condition_values="template_id=${item.template_id ?? 'none'} payload=${JSON.stringify(item.message_payload).slice(0, 80)}"`,
        );
        await this.queueService.markSkipped(
          item.id,
          SkipReason.MISSING_REQUIRED_DATA,
        );
        this.logger.log(
          `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="NO_BODY"`,
        );
        return;
      }

      if (resolvedImageUrl) {
        this.logger.log(
          `[PROMOTION_IMAGE_ATTACHED] queue_id=${item.id} phone=${item.customer_phone} image_url=${resolvedImageUrl}`,
        );
      } else {
        this.logger.log(
          `[PROMOTION_IMAGE_MISSING] queue_id=${item.id} phone=${item.customer_phone} — sending text-only`,
        );
      }

      // ── All gates passed — write log row BEFORE any send attempt ─────────────
      this.logger.log(
        `[MKT_LOG_CREATE_START] queue_id=${item.id} phone=${item.customer_phone} campaign_id=${item.campaign_id ?? 'none'}`,
      );
      logRow = await this.logRepo.save(
        this.logRepo.create({
          campaign_id: item.campaign_id ?? undefined,
          queue_id: item.id,
          number_id: number?.id ?? undefined,
          customer_phone: item.customer_phone,
          message_type: resolvedImageUrl ? MessageType.IMAGE : MessageType.TEXT,
          message_body: body,
          media_url: resolvedImageUrl ?? undefined,
          status: QueueStatus.PROCESSING,
        }),
      );
      this.logger.log(
        `[MKT_LOG_CREATE_SUCCESS] log_id=${logRow.id} queue_id=${item.id} phone=${item.customer_phone} campaign_id=${item.campaign_id ?? 'none'}`,
      );
      this.logger.log(
        `[MKT_DB_LOG_WRITE] log_id=${logRow.id} phone=${item.customer_phone} status=processing`,
      );

      // ── DRY RUN ──────────────────────────────────────────────────────────────
      if (process.env.WHATSAPP_ENGINE_DRY_RUN === 'true') {
        this.logger.log(
          `[DRY_RUN] Would send to ${item.customer_phone}: ${body.slice(0, 80)}`,
        );
        await this.queueService.markSent(item.id);
        await this.logRepo.update(logRow.id, {
          status: QueueStatus.SENT,
          sent_at: new Date(),
          wa_message_id: 'DRY_RUN',
        });
        await this.auditService.log({
          event: AuditEvent.DRY_RUN_SEND,
          number_id: item.number_id ?? undefined,
          customer_phone: item.customer_phone,
          template_id: item.template_id ?? undefined,
          reason: 'DRY_RUN mode active',
        });
        if (number) {
          await this.numbersService.incrementDailySent(number.id);
          await this.numbersService.updateLastMessageSent(number.id);
        }
        if (number && !isTestBypassMode()) {
          this._setNextAllowedSend(number.id);
        }
        this.logger.log(
          `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent(dry_run) attempts=${item.attempt_count ?? 0} failure_reason="none"`,
        );
        return;
      }

      if (!number?.id)
        throw new Error(
          'Queue item has no eligible sender number — cannot send',
        );

      // ── Actual WA send ───────────────────────────────────────────────────────
      // resolvedImageUrl comes from _resolveBody — never from stale in-memory payload
      const imageUrl = resolvedImageUrl ?? null;
      this.logger.log(
        `[MKT_BEFORE_WA_SEND] id=${item.id} phone=${item.customer_phone} ` +
          `number_id=${number.id} body_length=${body.length} has_image=${!!imageUrl} body_preview="${body.slice(0, 60)}"`,
      );

      let waResult: any;
      let sentAsImage = false;
      let imageFetchMs: number | null = null;
      let imageSizeKb: number | null = null;
      try {
        if (imageUrl) {
          const imgResult = await this.whatsAppService.sendViaNumberWithImage(
            number.id,
            item.customer_phone,
            imageUrl,
            body,
          );
          waResult = imgResult.result;
          sentAsImage = imgResult.sentAsImage;
          imageFetchMs = imgResult.imageFetchMs ?? null;
          imageSizeKb = imgResult.imageSizeKb ?? null;
        } else {
          waResult = await this.whatsAppService.sendViaNumber(
            number.id,
            item.customer_phone,
            body,
          );
        }
        this.logger.log(
          `[MKT_AFTER_WA_SEND] phone=${item.customer_phone} sent_as_image=${sentAsImage} ` +
            `result_id=${waResult?.id?._serialized ?? waResult?.id ?? 'null'} ` +
            `result_type=${typeof waResult} ` +
            `result_keys=${Object.keys(waResult ?? {}).join(',') || 'empty'}`,
        );
        this.logger.log(
          `[SENDER_AUDIT] wa_send_ok: queue_id=${item.id} phone=${item.customer_phone} ` +
            `number_id=${number.id} sent_as_image=${sentAsImage} wa_message_id=${waResult?.id?._serialized ?? waResult?.id ?? 'null'}`,
        );
      } catch (sendErr: any) {
        const errMsg: string = sendErr?.message ?? 'Unknown WA error';
        this.logger.error(
          `[MKT_SEND_FAIL] id=${item.id} phone=${item.customer_phone} ` +
            `template_id=${item.template_id ?? 'none'} ` +
            `error="${errMsg}" ` +
            `error_name=${sendErr?.name ?? 'unknown'} ` +
            `stack=${sendErr?.stack ?? 'none'}`,
        );

        // SEND_SKIPPED = WA client unavailable at send time → classify as SKIPPED (not a true failure)
        // Any other error = transport/delivery failure → classify as FAILED
        this.logger.error(
          `[SENDER_AUDIT] wa_send_fail: queue_id=${item.id} phone=${item.customer_phone} number_id=${number?.id ?? 'none'} error="${errMsg.slice(0, 120)}"`,
        );
        const isTransportSkip =
          errMsg.startsWith('[SEND_SKIPPED]') ||
          errMsg.includes('INVALID_WA_NUMBER');
        const mappedStatus = isTransportSkip
          ? QueueStatus.SKIPPED
          : QueueStatus.FAILED;
        this.logger.warn(
          `[MKT_STATUS_CLASSIFICATION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `raw_reason="${errMsg}" mapped_status=${mappedStatus} ` +
            `condition_values="number_id=${number?.id ?? 'none'}"`,
        );
        this.logger.warn(
          `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=WA_TRANSPORT reason="${errMsg}" ` +
            `condition_values="number_id=${number?.id ?? 'none'} mapped_status=${mappedStatus}"`,
        );

        const skipReason = isTransportSkip ? normalizeSkipReason(errMsg) : null;
        await this.logRepo.update(logRow.id, {
          status: mappedStatus,
          message_body: `${isTransportSkip ? skipReason : 'SEND_FAILED'}: ${errMsg}`,
        });

        if (isTransportSkip) {
          this.logger.log(
            `[MKT_MARK_SKIPPED] id=${item.id} phone=${item.customer_phone} reason="${errMsg}"`,
          );
          await this.queueService.markSkipped(item.id, errMsg);
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="${errMsg}"`,
          );

          // Mark audience contact as NOT_REGISTERED so future campaigns skip this number automatically
          if (errMsg.includes('INVALID_WA_NUMBER')) {
            this.audienceRepo
              .createQueryBuilder()
              .update(MarketingAudience)
              .set({
                wa_registration_status: 'NOT_REGISTERED',
                last_validation_at: new Date(),
              })
              .where('phone = :phone', { phone: item.customer_phone })
              .execute()
              .catch((e: any) =>
                this.logger.warn(
                  `[MKT_AUDIENCE_WA_STATUS_UPDATE_FAIL] phone=${item.customer_phone} error="${e?.message}"`,
                ),
              );
            this.logger.log(
              `[MKT_AUDIENCE_NOT_REGISTERED] phone=${item.customer_phone} — wa_registration_status=NOT_REGISTERED`,
            );
          }
        } else {
          this.logger.log(
            `[MKT_MARK_FAILED] id=${item.id} phone=${item.customer_phone} reason="${errMsg}"`,
          );
          await this.queueService.markFailed(item.id, errMsg);
          this.logger.log(
            `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=failed attempts=${item.attempt_count ?? 0} failure_reason="${errMsg}"`,
          );
        }
        return;
      }

      // Guard: only mark sent if WA returned a real message object
      const waMessageId = waResult?.id?._serialized ?? waResult?.id ?? null;
      if (!waMessageId) {
        this.logger.warn(
          `[MKT_AFTER_WA_SEND] WARNING no message ID in result — possible silent failure. ` +
            `full_result=${JSON.stringify(waResult)}`,
        );
      }

      // Bridge ACK race: register mapping synchronously before yielding to event loop.
      // ACK events (ack=2, ack=3) can fire before logRepo.update commits wa_message_id.
      if (waMessageId && logRow) {
        this.whatsAppService.registerPendingAck(waMessageId, logRow.id);
      }

      await this.logRepo.update(logRow.id, {
        status: QueueStatus.SENT,
        sent_at: new Date(),
        wa_message_id: waMessageId ?? 'NO_ID_CHECK_LOGS',
      });

      // wa_message_id now in DB — map entry no longer needed for DB fallback.
      if (waMessageId) {
        this.whatsAppService.deregisterPendingAck(waMessageId);
      }
      this.logger.log(
        `[MKT_DB_LOG_WRITE] log_id=${logRow.id} updated status=sent wa_message_id=${waMessageId}`,
      );

      await this.queueService.markSent(item.id);
      this.logger.log(
        `[MKT_MARK_SENT] id=${item.id} phone=${item.customer_phone} wa_message_id=${waMessageId}`,
      );

      await this.queueService
        .patchPayload(item.id, {
          image_analytics: {
            sentAsImage,
            imageAvailable: !!imageUrl,
            imageFetchMs,
            imageSizeKb,
          },
        })
        .catch(() => {});
      this.logger.log(
        `[MKT_SEND_SUCCESS] phone=${item.customer_phone} template_id=${item.template_id ?? 'none'} number_id=${number?.id ?? 'none'}`,
      );
      this.logger.log(
        `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent attempts=${item.attempt_count ?? 0} failure_reason="none"`,
      );

      if (number) {
        await this.numbersService.incrementDailySent(number.id);
        await this.numbersService.updateLastMessageSent(number.id);
      }

      if (!isTestBypassMode()) {
        this._setNextAllowedSend(number.id);
      }
    } catch (err: any) {
      const msg: string = err?.message ?? 'Unknown error';
      this.logger.error(
        `[MKT_SEND_FAIL] id=${item.id} phone=${item.customer_phone} ` +
          `template_id=${item.template_id ?? 'none'} ` +
          `error="${msg}" stack=${err?.stack ?? 'none'}`,
      );
      if (logRow) {
        await this.logRepo
          .update(logRow.id, {
            status: QueueStatus.FAILED,
            message_body: `FAILED: ${msg}`,
          })
          .catch(() => {});
      }
      this.logger.log(
        `[MKT_MARK_FAILED] id=${item.id} phone=${item.customer_phone} reason="${msg}"`,
      );
      await this.queueService.markFailed(item.id, msg).catch((dbErr: any) => {
        this.logger.error(
          `[MKT_MARK_FAILED_DB_ERROR] id=${item.id} db_error="${dbErr?.message}" — item may be stuck in PROCESSING`,
        );
      });
      this.logger.log(
        `[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=failed attempts=${item.attempt_count ?? 0} failure_reason="${msg}"`,
      );
    }
  }

  // Manual one-off send bypassing the queue (requires an active number)
  async sendMessage(
    numberId: string,
    phone: string,
    body: string,
  ): Promise<void> {
    await this.whatsAppService.sendViaNumber(numberId, phone, body);
  }

  private static readonly STORE_URL = 'https://www.heshstore.in';

  private async _resolveBody(
    item: WhatsappMessageQueue,
    senderPhone?: string,
    senderNumberId?: string,
  ): Promise<{ body: string | null; imageUrl: string | null }> {
    // ── Payload-only path (no template) ─────────────────────────────────────
    if (!item.template_id) {
      const rawPayload = item.message_payload as Record<string, unknown> | null;
      if (rawPayload?.['body']) {
        return {
          body: String(rawPayload['body']),
          imageUrl:
            (rawPayload['product_image'] as string | null | undefined) ?? null,
        };
      }
      return { body: null, imageUrl: null };
    }

    const template = await this.templatesService.findOne(item.template_id);
    const payload = (item.message_payload ?? {}) as Record<string, string>;

    // ── AI path — image-first, quality-gated, multi-product loop ────────────
    if (template.template_mode === TemplateMode.AI) {
      return this._resolveAiBody(
        item,
        template,
        payload,
        senderPhone,
        senderNumberId,
      );
    }

    // Base flat context for {{name}}, {{city}}, etc.
    const flatContext: Record<string, string> = {
      phone: item.customer_phone,
      name: payload.name ?? '',
      city: payload.city ?? '',
      business_type: payload.business_type ?? '',
    };

    // ── Step 1: generate base message body ───────────────────────────────────
    // AUTO templates call generateVariant (random greeting + fresh CTA rotation).
    // MANUAL templates use saved message_body with plain interpolation.
    let body: string;
    if (template.is_auto) {
      body = await this.messageAi.generateVariant(template.id, flatContext);
    } else {
      body = this.templatesService.interpolate(
        template.message_body,
        flatContext,
      );
    }

    // ── Step 2: resolve product + sender placeholders (supports dot-notation) ─
    // {{product.title}}, {{product.sku}}, {{product.image}},
    // {{product.link}}, {{sender.phone}}
    // Graceful fallback to '' — never throws, never blocks sending.
    const productVars: Record<string, string> = {
      'product.title': payload.product_name ?? '',
      'product.sku': payload.product_sku ?? '',
      'product.image': payload.product_image ?? '',
      'product.link': payload.product_link ?? SenderService.STORE_URL,
      'sender.phone': senderPhone ?? payload.sender_phone ?? '',
    };
    body = body.replace(
      /\{\{([\w.]+)\}\}/g,
      (_, key: string) => productVars[key] ?? flatContext[key] ?? '',
    );

    // ── Step 3: append CTA ───────────────────────────────────────────────────
    if (template.cta_type && template.cta_type !== CTAType.NONE) {
      const ctaPhone =
        senderPhone ?? payload.sender_phone ?? template.cta_url ?? '';
      const ctaUrl =
        payload.product_link ?? template.cta_url ?? SenderService.STORE_URL;
      const ctaLabel = template.cta_label ?? undefined;

      let ctaBlock: string | null = null;
      if (template.cta_type === CTAType.PHONE && ctaPhone) {
        ctaBlock = buildCta({
          type: 'call',
          phone: ctaPhone,
          callLabel: ctaLabel,
        });
      } else if (template.cta_type === CTAType.URL && ctaUrl) {
        ctaBlock = buildCta({
          type: 'product',
          url: ctaUrl,
          viewLabel: ctaLabel,
        });
      } else if (template.cta_label) {
        ctaBlock = template.cta_label;
      }

      if (ctaBlock) body = `${body}\n\n${ctaBlock}`;
    }

    const trimmed = body.trim() || null;
    const nonAiImageUrl = payload.product_image ?? null;
    return { body: trimmed, imageUrl: nonAiImageUrl };
  }

  // ── AI body — image-first, quality-gated, multi-product loop ─────────────────
  // Tries up to MAX_PRODUCT_ATTEMPTS distinct products per queue item.
  // A product is rejected when it has no image OR content quality stays below threshold.
  // Only the product that produces a passing result is recorded in the rotation log.

  private async _resolveAiBody(
    item: WhatsappMessageQueue,
    template: any,
    payload: Record<string, string>,
    senderPhone: string | undefined,
    senderNumberId: string | undefined,
  ): Promise<{ body: string | null; imageUrl: string | null }> {
    const telecallerNumberId =
      senderNumberId ?? item.actual_sender_number_id ?? item.number_id ?? null;
    if (!telecallerNumberId) {
      this.logger.warn(
        `[MKT_AI_TEMPLATE_SKIP] queue_id=${item.id} reason=no_telecaller_number_id`,
      );
      return { body: null, imageUrl: null };
    }

    // Resolve active offer once — same for all product attempts
    let activeOffer: { title?: string | null; text: string } | undefined;
    if (template.offer_enabled && template.offer_text) {
      const now = new Date();
      const startOk =
        !template.offer_start_date ||
        now >= new Date(template.offer_start_date);
      const endOk =
        !template.offer_end_date || now <= new Date(template.offer_end_date);
      if (startOk && endOk)
        activeOffer = {
          title: template.offer_title,
          text: template.offer_text,
        };
    }

    const triedSkus: string[] = [];

    for (
      let productAttempt = 0;
      productAttempt < MAX_PRODUCT_ATTEMPTS;
      productAttempt++
    ) {
      const product =
        await this.promotionProductService.getEligibleProductForTelecaller(
          telecallerNumberId,
          { campaignId: item.campaign_id ?? undefined, excludeSkus: triedSkus },
        );

      if (!product) {
        this.logger.warn(
          `[MKT_AI_TEMPLATE_SKIP] queue_id=${item.id} attempt=${productAttempt + 1} ` +
            `reason=no_eligible_product telecaller=${telecallerNumberId}`,
        );
        break;
      }

      triedSkus.push(product.sku ?? '');

      // ── PART 5: customer-product cooldown ────────────────────────────────────
      const onCooldown = await this._isCustomerProductCooldownActive(
        item.customer_phone,
        product.sku ?? '',
        PRODUCT_CUSTOMER_COOLDOWN_DAYS,
      );
      if (onCooldown) {
        this.logger.log(
          `[PROMOTION_PRODUCT_SKIPPED] queue_id=${item.id} sku=${product.sku} ` +
            `reason=customer_product_cooldown days=${PRODUCT_CUSTOMER_COOLDOWN_DAYS} phone=${item.customer_phone}`,
        );
        continue;
      }

      // ── Generate ──────────────────────────────────────────────────────────────
      const result = await this.promotionAiService.generate({
        telecaller_number_id: telecallerNumberId,
        telecaller_phone: senderPhone ?? '',
        product,
        template_id: item.template_id ?? undefined,
        customer: {
          name: payload.name ?? '',
          city: payload.city ?? '',
          business_type: payload.business_type ?? '',
          phone: item.customer_phone,
        },
        campaign_id: item.campaign_id ?? undefined,
        offer: activeOffer,
      });

      // ── PART 1: image-first enforcement ──────────────────────────────────────
      if (!result.imageUrl) {
        this.logger.warn(
          `[PROMOTION_IMAGE_REQUIRED] queue_id=${item.id} sku=${product.sku} attempt=${productAttempt + 1} ` +
            `— AI promo requires product image; none found`,
        );
        this.logger.warn(
          `[PROMOTION_PRODUCT_SKIPPED] queue_id=${item.id} sku=${product.sku} reason=no_image`,
        );
        continue;
      }

      // ── PART 3: hard quality gate ─────────────────────────────────────────────
      if (!result.qualityPassed) {
        this.logger.warn(
          `[PROMOTION_WEAK_CONTENT] queue_id=${item.id} sku=${product.sku} attempt=${productAttempt + 1} ` +
            `score=${result.quality.finalScore} grade=${result.quality.grade} attempts_used=${result.quality.attemptsUsed}`,
        );
        this.logger.warn(
          `[PROMOTION_PRODUCT_SKIPPED] queue_id=${item.id} sku=${product.sku} ` +
            `reason=weak_content score=${result.quality.finalScore}`,
        );
        continue;
      }

      // ── PART 4: URL source safety gate ───────────────────────────────────────
      // Products with no Shopify handle and no SKU are rejected at generation time
      // (urlSource='rejected'). Double-check here before writing to the queue so a
      // future code path change cannot accidentally slip a blank URL through.
      if (result.metadata.urlSource === 'rejected') {
        this.logger.warn(
          `[PROMOTION_PRODUCT_SKIPPED] queue_id=${item.id} sku=${product.sku} ` +
            `reason=url_rejected url_source=rejected`,
        );
        continue;
      }

      // ── All gates passed — record rotation + persist payload ─────────────────
      await this.promotionProductService.recordProductSent(
        telecallerNumberId,
        product,
        item.campaign_id ?? undefined,
      );

      await this.queueService.patchPayload(item.id, {
        generated_message: result.message,
        product_sku: product.sku,
        product_id: product.id,
        product_image: result.imageUrl,
        product_url: result.productUrl,
        url_source: result.metadata.urlSource,
        ai_metadata: result.metadata,
        quality: result.quality,
        offer_applied: !!activeOffer,
      });

      this.logger.log(
        `[MKT_AI_TEMPLATE_OK] queue_id=${item.id} sku=${product.sku} ` +
          `score=${result.quality.finalScore} product_attempt=${productAttempt + 1} ` +
          `url_source=${result.metadata.urlSource}`,
      );

      return { body: result.message, imageUrl: result.imageUrl };
    }

    // All product attempts exhausted without a passing result
    this.logger.warn(
      `[MKT_AI_TEMPLATE_SKIP] queue_id=${item.id} reason=all_products_rejected ` +
        `tried_skus=${JSON.stringify(triedSkus)} max_attempts=${MAX_PRODUCT_ATTEMPTS}`,
    );
    return { body: null, imageUrl: null };
  }

  // ── PART 5: customer-product cooldown query ───────────────────────────────────
  // Prevents the same customer from receiving the same SKU within cooldownDays.
  // Joins message_logs → message_queue on queue_id to read the JSONB product_sku.

  private async _isCustomerProductCooldownActive(
    customerPhone: string,
    sku: string,
    cooldownDays: number,
  ): Promise<boolean> {
    if (!sku) return false;
    const cutoff = new Date(Date.now() - cooldownDays * 24 * 3_600_000);
    const count = await this.logRepo
      .createQueryBuilder('l')
      .innerJoin('whatsapp_message_queue', 'q', 'l.queue_id = q.id')
      .where('l.customer_phone = :phone', { phone: customerPhone })
      .andWhere('l.sent_at >= :cutoff', { cutoff })
      .andWhere(`q.message_payload->>'product_sku' = :sku`, { sku })
      .andWhere('l.status IN (:...statuses)', {
        statuses: ['sent', 'delivered', 'read', 'replied'],
      })
      .getCount();
    return count > 0;
  }
}

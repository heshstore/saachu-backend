import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { CTAType, MessageType, QueueStatus, TemplateMode } from '../entities/enums';
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
import { WhatsappNumber } from '../entities/whatsapp-number.entity';

// Hard limits per warmup level (1=COLD, 2=WARM, 3=HOT, 4=SEASONED)
const HARD_LIMITS: Record<number, { daily: number; hourly: number }> = {
  1: { daily: 30, hourly: 5 },
  2: { daily: 80, hourly: 12 },
  3: { daily: 150, hourly: 20 },
  4: { daily: 200, hourly: 30 },
};

// Tighter limits for pilot mode (WHATSAPP_ENGINE_PILOT_MODE=true)
const PILOT_LIMITS: Record<number, { daily: number; hourly: number }> = {
  1: { daily: 10, hourly: 2 },
  2: { daily: 20, hourly: 5 },
  3: { daily: 30, hourly: 7 },
  4: { daily: 50, hourly: 10 },
};

function getActiveLimits(warmupLevel: number): { daily: number; hourly: number } {
  const table = process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true' ? PILOT_LIMITS : HARD_LIMITS;
  return table[warmupLevel] ?? table[1];
}

const CONTENT_FINGERPRINT_DAYS = 3;

// Human-like inter-send delay: 30s–5min; 10% chance of 15–30min idle window
const MIN_DELAY_MS  = 30_000;
const MAX_DELAY_MS  = 5 * 60_000;
const IDLE_PROB     = 0.10;
const MIN_IDLE_MS   = 15 * 60_000;
const MAX_IDLE_MS   = 30 * 60_000;

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
  private _nextAllowedSend: Date = new Date(0); // initially ready immediately

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(WhatsappMessageLog)
    private logRepo: Repository<WhatsappMessageLog>,
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
  ) {
    this.logger.log('[MKT_SENDER_CONSTRUCTED] SenderService constructor called');
  }

  onModuleInit(): void {
    this.logger.log(
      `[MKT_SENDER_BOOT] SenderService onModuleInit — ` +
      `engine_enabled=${process.env.WHATSAPP_ENGINE_ENABLED} ` +
      `test_only=${process.env.WHATSAPP_ENGINE_TEST_ONLY} ` +
      `bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );
    this.logger.log('[MKT_SENDER_CRON_REGISTERED] @Interval(15s) is the sole tick source');
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

  @Interval(15_000)
  async tick(): Promise<void> {
    const connected    = this.whatsAppService.isAnyConnected();
    const enabled      = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    const inWindow     = this.timingAi.isWithinSendWindow();
    const testBypass   = isTestBypassMode();
    const delayMs      = Math.max(0, this._nextAllowedSend.getTime() - Date.now());
    // In TEST_ONLY+BYPASS mode all human delay is disabled so testing is never blocked.
    const delayPending = !testBypass && delayMs > 0;
    const lockedNumbers = [...this._numberLocks.entries()].filter(([, v]) => v).map(([k]) => k);

    this.logger.log(
      `[MKT_SENDER_TICK] enabled=${enabled} connected=${connected} ` +
      `inWindow=${inWindow} lockedNumbers=${JSON.stringify(lockedNumbers)} ` +
      `delayPending=${delayPending} nextAllowedSend=${this._nextAllowedSend.toISOString()} ` +
      `testOnly=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );
    this.logger.log(
      `[MKT_DELAY_DEBUG] now=${new Date().toISOString()} ` +
      `nextAllowedSend=${this._nextAllowedSend.toISOString()} ` +
      `delayMs=${delayMs} ` +
      `source=${testBypass ? 'bypassed_test_mode' : delayMs > 0 ? 'human_delay_active' : 'clear'}`,
    );

    if (!enabled)            { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=engine_disabled'); return; }
    if (this._tickSelecting) { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=tick_selecting'); return; }
    if (delayPending)        { this.logger.log(`[MKT_SENDER_TICK_SKIP] reason=human_delay until=${this._nextAllowedSend.toISOString()}`); return; }
    if (!connected)          { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=no_wa_connection — waiting for client ready'); return; }

    // Window check: outside business hours blocks live sends but not test_mode campaigns.
    let windowBypassed = false;
    if (!inWindow) {
      const testPending = await this.queueService.findTestModePending(1);
      if (!testPending.length) {
        this.logger.log(`[MKT_SENDER_TICK_SKIP] reason=outside_send_window bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`);
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
    let selectedItem: WhatsappMessageQueue | null = null;
    let selectedNumber: WhatsappNumber | null = null;

    try {
      this.logger.log(
        `[MKT_SENDER_QUEUE_PATH] windowBypassed=${windowBypassed} inWindow=${inWindow} ` +
        `using=${windowBypassed ? 'findTestModePending' : 'findPending'} ` +
        `testBypass=${testBypass}`,
      );
      const pending = windowBypassed
        ? await this.queueService.findTestModePending(10)
        : await this.queueService.findPending(10);

      this.logger.log(
        `[MKT_PENDING_QUERY_RESULT] count=${pending.length} phones=${JSON.stringify(pending.map(p => p.customer_phone))} ids=${JSON.stringify(pending.map(p => p.id))}`,
      );
      this.logger.log(`[MKT_QUEUE_FETCHED] pending_count=${pending.length} ids=${JSON.stringify(pending.map(p => p.id))}`);

      if (pending.length) {
        const allNumbers = await this.numbersService.findAll();

        // ── STAGE 1: total pool ───────────────────────────────────────────────
        this.logger.log(
          `[MKT_POOL_STAGE_1] total=${allNumbers.length} ` +
          `numbers=${JSON.stringify(allNumbers.map(n => ({
            id: n.id, phone: n.phone,
            is_active: n.is_active, status: n.status,
            wa_state: n.wa_state,
            daily_sent: n.daily_sent,
            db_daily_limit: n.daily_limit,
            effective_daily_cap: getActiveLimits(n.warmup_level).daily,
            warmup_level: n.warmup_level,
          })))}`,
        );

        // ── STAGE 2: after is_active filter ──────────────────────────────────
        const s2: typeof allNumbers = [];
        for (const n of allNumbers) {
          if (n.is_active) { s2.push(n); }
          else { this.logger.log(`[MKT_POOL_STAGE_2_DROP] id=${n.id} phone=${n.phone} reason=is_active=false`); }
        }
        this.logger.log(`[MKT_POOL_STAGE_2] after_active=${s2.length} dropped=${allNumbers.length - s2.length}`);

        // ── STAGE 3: after wa_state='ready' filter ────────────────────────────
        const s3: typeof allNumbers = [];
        for (const n of s2) {
          if (n.wa_state === 'ready') { s3.push(n); }
          else { this.logger.log(`[MKT_POOL_STAGE_3_DROP] id=${n.id} phone=${n.phone} reason=wa_state=${n.wa_state ?? 'null'}`); }
        }
        this.logger.log(`[MKT_POOL_STAGE_3] after_ready=${s3.length} dropped=${s2.length - s3.length}`);

        // ── STAGE 4: after isConnected() filter ───────────────────────────────
        const s4: typeof allNumbers = [];
        for (const n of s3) {
          const diag = this.whatsAppService.getConnectionDiagnostics(n.id);
          if (diag.isConnectedResult) {
            s4.push(n);
          } else {
            this.logger.log(
              `[MKT_POOL_STAGE_4_DROP] id=${n.id} phone=${n.phone} reason=isConnected=false ` +
              `inClientsMap=${diag.inClientsMap} hasClient=${diag.hasClient} ` +
              `destroyed=${diag.destroyed} waState=${diag.waState} ` +
              `pageExists=${diag.pageExists} pageOpen=${diag.pageOpen} ` +
              `browserConnected=${diag.browserConnected}`,
            );
          }
        }
        this.logger.log(`[MKT_POOL_STAGE_4] after_connected=${s4.length} dropped=${s3.length - s4.length}`);

        // ── STAGE 5: after warmup/daily-cap filter ────────────────────────────
        const s5: typeof allNumbers = [];
        for (const n of s4) {
          const lim = getActiveLimits(n.warmup_level);
          if (n.daily_sent < lim.daily) {
            s5.push(n);
          } else {
            this.logger.log(
              `[MKT_POOL_STAGE_5_DROP] id=${n.id} phone=${n.phone} reason=daily_cap ` +
              `daily_sent=${n.daily_sent} effective_cap=${lim.daily} ` +
              `db_daily_limit=${n.daily_limit} warmup_level=${n.warmup_level} ` +
              `pilot_mode=${process.env.WHATSAPP_ENGINE_PILOT_MODE}`,
            );
          }
        }
        this.logger.log(`[MKT_POOL_STAGE_5] after_daily_cap=${s5.length} dropped=${s4.length - s5.length}`);

        const eligibleNumbers = s5;

        // ── STAGE 6: lock filter + selection ─────────────────────────────────
        for (const item of pending) {
          let preferred = eligibleNumbers.find(n => n.id === item.number_id) ?? null;
          if (!preferred) {
            const sorted = [...eligibleNumbers].sort((a, b) => a.daily_sent - b.daily_sent);
            preferred = sorted[0] ?? null;
          }
          if (preferred) {
            const locked = this._isNumberLocked(preferred.id);
            this.logger.log(`[MKT_POOL_STAGE_6] queueId=${item.id} preferred=${preferred.phone} locked=${locked}`);
            if (!locked) {
              selectedItem = item;
              selectedNumber = preferred;
              this._lockNumber(preferred.id);
              this.logger.log(`[MKT_NUMBER_LOCK_ACQUIRED] numberId=${preferred.id} phone=${preferred.phone} queueId=${item.id}`);
              break;
            }
          } else {
            this.logger.log(`[MKT_POOL_STAGE_6] queueId=${item.id} preferred=none reason=no_eligible_numbers`);
          }
        }

        if (!selectedItem) {
          this.logger.log('[MKT_SENDER_TICK_SKIP] reason=all_eligible_numbers_locked');
        }
      } else {
        this.logger.log('[MKT_SENDER_TICK_SKIP] reason=queue_empty');
      }
    } catch (err: any) {
      this.logger.error(`[MKT_SCHEDULER_FATAL] tick selection crashed: ${err?.message}\n${err?.stack}`);
    } finally {
      this._tickSelecting = false;
    }

    if (!selectedItem || !selectedNumber) return;

    this.logger.log(
      `[MKT_QUEUE_ITEM_PROCESS] id=${selectedItem.id} phone=${selectedItem.customer_phone} ` +
      `template_id=${selectedItem.template_id ?? 'none'} scheduled_at=${selectedItem.scheduled_at?.toISOString()}`,
    );

    try {
      await this.processNext(selectedItem, selectedNumber);
    } catch (err: any) {
      this.logger.error(`[MKT_SCHEDULER_FATAL] tick crashed: ${err?.message}\n${err?.stack}`);
    } finally {
      this._unlockNumber(selectedNumber.id);
      this.logger.log(`[MKT_NUMBER_LOCK_RELEASED] numberId=${selectedNumber.id} phone=${selectedNumber.phone} queueId=${selectedItem.id}`);
    }
  }

  // Outer shell: guarantees [MKT_PROCESS_COMPLETE] fires regardless of outcome
  async processNext(item: WhatsappMessageQueue, preselectedNumber?: WhatsappNumber): Promise<void> {
    this.logger.log(
      `[MKT_PROCESS_START] id=${item.id} phone=${item.customer_phone} ` +
      `template_id=${item.template_id ?? 'none'} campaign_id=${item.campaign_id ?? 'none'} ` +
      `number_id=${item.number_id ?? 'none'} scheduled_at=${item.scheduled_at?.toISOString()}`,
    );
    try {
      await this._processNextInternal(item, preselectedNumber);
    } finally {
      this.logger.log(`[MKT_PROCESS_COMPLETE] id=${item.id} phone=${item.customer_phone}`);
    }
  }

  private async _processNextInternal(item: WhatsappMessageQueue, preselectedNumber?: WhatsappNumber): Promise<void> {
    await this.queueService.markProcessing(item.id);

    // logRow is written before any send attempt — guarantees DB visibility even on crash
    let logRow: WhatsappMessageLog | null = null;

    try {
      // ── Gate: TEST_ONLY ─────────────────────────────────────────────────────
      if (process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true') {
        const testPhones = await this.audienceService.getTestPhones();
        const normalizedQueue      = normalizePhone(item.customer_phone);
        const normalizedTestPhones = testPhones.map(normalizePhone);
        const matched              = normalizedTestPhones.includes(normalizedQueue);
        this.logger.log(
          `[MKT_TEST_CONTACT_MATCH] phone=${item.customer_phone} testPhones=${JSON.stringify(testPhones)} matched=${matched}`,
        );
        this.logger.log(
          `[MKT_TEST_CONTACT_NORMALIZED] queuePhone=${normalizedQueue} matched=${matched}`,
        );
        if (!matched) {
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=TEST_ONLY reason="not a test contact" condition_values="testPhones=${JSON.stringify(testPhones)}"`,
          );
          await this.queueService.markSkipped(item.id, 'TEST_ONLY mode: not a test contact');
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="TEST_ONLY: not a test contact"`);
          return;
        }
      }

      // ── Gate: sender pool selection ─────────────────────────────────────────
      // If tick pre-selected a number (lock already acquired), use it directly.
      // Otherwise build the pool from scratch (manual / non-tick callers).
      let number: WhatsappNumber | null = preselectedNumber ?? null;

      if (!number) {
        const allNumbers = await this.numbersService.findAll();
        const eligibleNumbers = allNumbers.filter(n => {
          if (!n.is_active) return false;
          if (n.wa_state !== 'ready') return false;
          if (!this.whatsAppService.isConnected(n.id)) return false;
          const nLimits = getActiveLimits(n.warmup_level);
          return n.daily_sent < nLimits.daily;
        });

        this.logger.log(
          `[MKT_SENDER_POOL] queue_id=${item.id} total=${allNumbers.length} ` +
          `eligible=${eligibleNumbers.length} numbers=[${eligibleNumbers.map(n => n.phone).join(',')}]`,
        );

        if (!eligibleNumbers.length) {
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=NO_ELIGIBLE_SENDER reason="no connected numbers with daily capacity" ` +
            `condition_values="total_numbers=${allNumbers.length}"`,
          );
          await this.queueService.markSkipped(item.id, 'NO_ELIGIBLE_SENDER: no connected numbers with capacity');
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="NO_ELIGIBLE_SENDER"`);
          return;
        }

        // Prefer assigned number if it is in the eligible pool; otherwise pick lowest daily_sent.
        number = eligibleNumbers.find(n => n.id === item.number_id) ?? null;
        if (!number) {
          eligibleNumbers.sort((a, b) => a.daily_sent - b.daily_sent);
          number = eligibleNumbers[0];
        }

        this.logger.log(
          `[MKT_SENDER_SELECTED] queue_id=${item.id} number=${number.phone} ` +
          `number_id=${number.id} daily_sent=${number.daily_sent} ` +
          `reason=${number.id === item.number_id ? 'assigned' : 'lowest_usage_failover'}`,
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
      await this.queueService.assignSender(item.id, number.id, number.phone, number.name);

      // Hourly cap check on the selected number
      const limits = getActiveLimits(number.warmup_level);
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      const sentLastHour = await this.logRepo
        .createQueryBuilder('l')
        .where('l.number_id = :nid', { nid: number.id })
        .andWhere('l.sent_at >= :oneHourAgo', { oneHourAgo })
        .andWhere('l.status != :failed', { failed: QueueStatus.FAILED })
        .getCount();

      if (sentLastHour >= limits.hourly) {
        this.logger.log(
          `[MKT_HOURLY_CAP_DEFER] queue_id=${item.id} phone=${item.customer_phone} ` +
          `sent_last_hour=${sentLastHour} hourly_limit=${limits.hourly} warmup=${number.warmup_level} ` +
          `— deferring 1 hour instead of permanently skipping`,
        );
        await this.queueService.markDeferred(item.id, `Hourly cap (${limits.hourly}/hr) — retry after 1h`);
        await this.auditService.log({
          event: AuditEvent.HOURLY_CAP_HIT,
          number_id: number.id,
          customer_phone: item.customer_phone,
          template_id: item.template_id ?? undefined,
          reason: `sent_last_hour=${sentLastHour} >= hourly_cap=${limits.hourly} — deferred`,
        });
        this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=deferred_pending attempts=${item.attempt_count ?? 0} failure_reason="HOURLY_CAP_DEFERRED: ${sentLastHour}/${limits.hourly}"`);
        return;
      }

      // ── Gate: content fingerprint ────────────────────────────────────────────
      // AI templates generate unique content per send — fingerprint by template_id is meaningless.
      const isAiTemplate = item.template_id
        ? (await this.templatesService.findOne(item.template_id).catch(() => null))?.template_mode === TemplateMode.AI
        : false;

      if (item.template_id && !isAiTemplate) {
        const fingerprintCutoff = new Date(
          Date.now() - CONTENT_FINGERPRINT_DAYS * 24 * 3600 * 1000,
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
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=CONTENT_FINGERPRINT reason="same template sent within ${CONTENT_FINGERPRINT_DAYS} days" ` +
            `condition_values="template_id=${item.template_id} recent_matches=${recentSame}"`,
          );
          await this.queueService.markSkipped(item.id, `Content fingerprint: same template sent recently`);
          await this.auditService.log({
            event: AuditEvent.FINGERPRINT_SKIP,
            number_id: item.number_id ?? undefined,
            customer_phone: item.customer_phone,
            template_id: item.template_id,
            reason: `Template already sent to this phone within ${CONTENT_FINGERPRINT_DAYS} days`,
          });
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="FINGERPRINT: template_id=${item.template_id}"`);
          return;
        }
      }

      // ── Resolve body ─────────────────────────────────────────────────────────
      const body = await this._resolveBody(item, number?.phone ?? undefined, number?.id ?? undefined);
      if (body === null) {
        this.logger.warn(
          `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
          `rule=NO_BODY reason="no usable message body" ` +
          `condition_values="template_id=${item.template_id ?? 'none'} payload=${JSON.stringify(item.message_payload).slice(0, 80)}"`,
        );
        await this.queueService.markSkipped(item.id, 'No usable message body');
        this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="NO_BODY"`);
        return;
      }

      // ── All gates passed — write log row BEFORE any send attempt ─────────────
      this.logger.log(`[MKT_LOG_CREATE_START] queue_id=${item.id} phone=${item.customer_phone} campaign_id=${item.campaign_id ?? 'none'}`);
      logRow = await this.logRepo.save(this.logRepo.create({
        campaign_id: item.campaign_id ?? undefined,
        queue_id: item.id,
        number_id: number?.id ?? undefined,
        customer_phone: item.customer_phone,
        message_type: MessageType.TEXT,
        message_body: body,
        status: QueueStatus.PROCESSING,
      }));
      this.logger.log(
        `[MKT_LOG_CREATE_SUCCESS] log_id=${logRow.id} queue_id=${item.id} phone=${item.customer_phone} campaign_id=${item.campaign_id ?? 'none'}`,
      );
      this.logger.log(
        `[MKT_DB_LOG_WRITE] log_id=${logRow.id} phone=${item.customer_phone} status=processing`,
      );

      // ── DRY RUN ──────────────────────────────────────────────────────────────
      if (process.env.WHATSAPP_ENGINE_DRY_RUN === 'true') {
        this.logger.log(`[DRY_RUN] Would send to ${item.customer_phone}: ${body.slice(0, 80)}`);
        await this.queueService.markSent(item.id);
        await this.logRepo.update(logRow.id, { status: QueueStatus.SENT, sent_at: new Date(), wa_message_id: 'DRY_RUN' });
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
        if (!isTestBypassMode()) {
          this._nextAllowedSend = new Date(Date.now() + humanDelay());
        }
        this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent(dry_run) attempts=${item.attempt_count ?? 0} failure_reason="none"`);
        return;
      }

      if (!number?.id) throw new Error('Queue item has no eligible sender number — cannot send');

      // ── Actual WA send ───────────────────────────────────────────────────────
      this.logger.log(
        `[MKT_BEFORE_WA_SEND] id=${item.id} phone=${item.customer_phone} ` +
        `number_id=${number.id} body_length=${body.length} body_preview="${body.slice(0, 60)}"`,
      );

      let waResult: any;
      try {
        waResult = await this.whatsAppService.sendViaNumber(number.id, item.customer_phone, body);
        this.logger.log(
          `[MKT_AFTER_WA_SEND] phone=${item.customer_phone} ` +
          `result_id=${waResult?.id?._serialized ?? waResult?.id ?? 'null'} ` +
          `result_type=${typeof waResult} ` +
          `result_keys=${Object.keys(waResult ?? {}).join(',') || 'empty'}`,
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
        const isTransportSkip = errMsg.startsWith('[SEND_SKIPPED]') || errMsg.includes('INVALID_WA_NUMBER');
        const mappedStatus = isTransportSkip ? QueueStatus.SKIPPED : QueueStatus.FAILED;
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

        await this.logRepo.update(logRow.id, {
          status: mappedStatus,
          message_body: `${isTransportSkip ? 'SKIPPED' : 'SEND_FAILED'}: ${errMsg}`,
        });

        if (isTransportSkip) {
          this.logger.log(`[MKT_MARK_SKIPPED] id=${item.id} phone=${item.customer_phone} reason="${errMsg}"`);
          await this.queueService.markSkipped(item.id, errMsg);
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="${errMsg}"`);
        } else {
          this.logger.log(`[MKT_MARK_FAILED] id=${item.id} phone=${item.customer_phone} reason="${errMsg}"`);
          await this.queueService.markFailed(item.id, errMsg);
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=failed attempts=${item.attempt_count ?? 0} failure_reason="${errMsg}"`);
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
      this.logger.log(
        `[MKT_SEND_SUCCESS] phone=${item.customer_phone} template_id=${item.template_id ?? 'none'} number_id=${number?.id ?? 'none'}`,
      );
      this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent attempts=${item.attempt_count ?? 0} failure_reason="none"`);

      if (number) {
        await this.numbersService.incrementDailySent(number.id);
        await this.numbersService.updateLastMessageSent(number.id);
      }

      if (!isTestBypassMode()) {
        this._nextAllowedSend = new Date(Date.now() + humanDelay());
      }

    } catch (err: any) {
      const msg: string = err?.message ?? 'Unknown error';
      this.logger.error(
        `[MKT_SEND_FAIL] id=${item.id} phone=${item.customer_phone} ` +
        `template_id=${item.template_id ?? 'none'} ` +
        `error="${msg}" stack=${err?.stack ?? 'none'}`,
      );
      if (logRow) {
        await this.logRepo.update(logRow.id, {
          status: QueueStatus.FAILED,
          message_body: `FAILED: ${msg}`,
        }).catch(() => {});
      }
      this.logger.log(`[MKT_MARK_FAILED] id=${item.id} phone=${item.customer_phone} reason="${msg}"`);
      await this.queueService.markFailed(item.id, msg).catch((dbErr: any) => {
        this.logger.error(`[MKT_MARK_FAILED_DB_ERROR] id=${item.id} db_error="${dbErr?.message}" — item may be stuck in PROCESSING`);
      });
      this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=failed attempts=${item.attempt_count ?? 0} failure_reason="${msg}"`);
    }
  }

  // Manual one-off send bypassing the queue (requires an active number)
  async sendMessage(numberId: string, phone: string, body: string): Promise<void> {
    await this.whatsAppService.sendViaNumber(numberId, phone, body);
  }

  private static readonly STORE_URL = 'https://www.heshstore.in';

  private async _resolveBody(item: WhatsappMessageQueue, senderPhone?: string, senderNumberId?: string): Promise<string | null> {
    // ── Payload-only path (no template) ─────────────────────────────────────
    if (!item.template_id) {
      const rawPayload = item.message_payload as Record<string, unknown> | null;
      if (rawPayload?.['body']) return String(rawPayload['body']);
      return null;
    }

    const template = await this.templatesService.findOne(item.template_id);
    const payload = (item.message_payload ?? {}) as Record<string, string>;

    // ── AI path — full message generated by PromotionAiTemplateService ───────
    if (template.template_mode === TemplateMode.AI) {
      const telecallerNumberId = senderNumberId ?? item.actual_sender_number_id ?? item.number_id ?? null;
      if (!telecallerNumberId) {
        this.logger.warn(`[MKT_AI_TEMPLATE_SKIP] queue_id=${item.id} reason=no_telecaller_number_id`);
        return null;
      }

      const product = await this.promotionProductService.getEligibleProductForTelecaller(
        telecallerNumberId,
        { campaignId: item.campaign_id ?? undefined },
      );
      if (!product) {
        this.logger.warn(`[MKT_AI_TEMPLATE_SKIP] queue_id=${item.id} reason=no_eligible_product telecaller=${telecallerNumberId}`);
        return null;
      }

      // Resolve active offer from template — DB-sourced, date-bounded, never AI-generated
      let activeOffer: { title?: string | null; text: string } | undefined;
      if (template.offer_enabled && template.offer_text) {
        const now = new Date();
        const startOk = !template.offer_start_date || now >= new Date(template.offer_start_date);
        const endOk   = !template.offer_end_date   || now <= new Date(template.offer_end_date);
        if (startOk && endOk) {
          activeOffer = { title: template.offer_title, text: template.offer_text };
        }
      }

      const result = await this.promotionAiService.generate({
        telecaller_number_id: telecallerNumberId,
        telecaller_phone:     senderPhone ?? '',
        product,
        template_id:          item.template_id ?? undefined,
        customer: {
          name:          payload.name ?? '',
          city:          payload.city ?? '',
          business_type: payload.business_type ?? '',
          phone:         item.customer_phone,
        },
        campaign_id: item.campaign_id ?? undefined,
        offer:       activeOffer,
      });

      // Record rotation so this telecaller doesn't repeat the same product within 24h
      await this.promotionProductService.recordProductSent(
        telecallerNumberId,
        product,
        item.campaign_id ?? undefined,
      );

      // Persist AI metadata into queue payload for analytics / audit
      await this.queueService.patchPayload(item.id, {
        generated_message: result.message,
        product_sku:       product.sku,
        product_id:        product.id,
        ai_metadata:       result.metadata,
        offer_applied:     !!activeOffer,
      });

      return result.message;
    }

    // Base flat context for {{name}}, {{city}}, etc.
    const flatContext: Record<string, string> = {
      phone:         item.customer_phone,
      name:          payload.name ?? '',
      city:          payload.city ?? '',
      business_type: payload.business_type ?? '',
    };

    // ── Step 1: generate base message body ───────────────────────────────────
    // AUTO templates call generateVariant (random greeting + fresh CTA rotation).
    // MANUAL templates use saved message_body with plain interpolation.
    let body: string;
    if (template.is_auto) {
      body = await this.messageAi.generateVariant(template.id, flatContext);
    } else {
      body = this.templatesService.interpolate(template.message_body, flatContext);
    }

    // ── Step 2: resolve product + sender placeholders (supports dot-notation) ─
    // {{product.title}}, {{product.sku}}, {{product.image}},
    // {{product.link}}, {{sender.phone}}
    // Graceful fallback to '' — never throws, never blocks sending.
    const productVars: Record<string, string> = {
      'product.title': payload.product_name  ?? '',
      'product.sku':   payload.product_sku   ?? '',
      'product.image': payload.product_image ?? '',
      'product.link':  payload.product_link  ?? SenderService.STORE_URL,
      'sender.phone':  senderPhone ?? payload.sender_phone ?? '',
    };
    body = body.replace(
      /\{\{([\w.]+)\}\}/g,
      (_, key: string) => productVars[key] ?? flatContext[key] ?? '',
    );

    // ── Step 3: append CTA ───────────────────────────────────────────────────
    if (template.cta_type && template.cta_type !== CTAType.NONE && template.cta_label) {
      let ctaValue: string;
      if (template.cta_type === CTAType.PHONE) {
        // PHONE CTA — use the actual sender number assigned to this queue item
        ctaValue = senderPhone ?? payload.sender_phone ?? template.cta_url ?? '';
      } else {
        // URL CTA — product link > template cta_url > store fallback
        ctaValue = payload.product_link ?? template.cta_url ?? SenderService.STORE_URL;
      }
      body = ctaValue
        ? `${body}\n\n${template.cta_label}: ${ctaValue}`
        : `${body}\n\n${template.cta_label}`;
    }

    return body.trim() || null;
  }
}

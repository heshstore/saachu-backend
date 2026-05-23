import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { MessageType, QueueStatus } from '../entities/enums';
import { QueueService } from '../queue/queue.service';
import { TemplatesService } from '../templates/templates.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { NumbersService } from '../numbers/numbers.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineAuditService, AuditEvent } from '../engine/engine-audit.service';
import { AudienceService } from '../audience/audience.service';

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

@Injectable()
export class SenderService implements OnModuleInit {
  private readonly logger = new Logger(SenderService.name);
  private _sending = false;
  private _nextAllowedSend: Date = new Date(0); // initially ready immediately

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(WhatsappMessageLog)
    private logRepo: Repository<WhatsappMessageLog>,
    private readonly queueService: QueueService,
    private readonly templatesService: TemplatesService,
    private readonly timingAi: TimingAiService,
    private readonly numbersService: NumbersService,
    private readonly whatsAppService: MarketingWhatsAppService,
    private readonly auditService: EngineAuditService,
    private readonly audienceService: AudienceService,
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

  @Interval(15_000)
  async tick(): Promise<void> {
    // Log at the absolute first line — visible even when all other conditions fail
    const connected = this.whatsAppService.isAnyConnected();
    const enabled = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    const inWindow = this.timingAi.isWithinSendWindow();
    const sendingLocked = this._sending;
    const delayPending = Date.now() < this._nextAllowedSend.getTime();

    this.logger.log(
      `[MKT_SENDER_TICK] enabled=${enabled} connected=${connected} ` +
      `inWindow=${inWindow} sendingLocked=${sendingLocked} ` +
      `delayPending=${delayPending} nextAllowedSend=${this._nextAllowedSend.toISOString()} ` +
      `testOnly=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );

    if (!enabled)      { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=engine_disabled'); return; }
    if (sendingLocked) { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=already_sending'); return; }
    if (delayPending)  { this.logger.log(`[MKT_SENDER_TICK_SKIP] reason=human_delay until=${this._nextAllowedSend.toISOString()}`); return; }
    if (!connected)    { this.logger.log('[MKT_SENDER_TICK_SKIP] reason=no_wa_connection — waiting for client ready'); return; }
    if (!inWindow)     { this.logger.log(`[MKT_SENDER_TICK_SKIP] reason=outside_send_window bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`); return; }

    this.logger.log(
      `[MKT_SCHEDULER_TICK] inWindow=${inWindow} testOnly=${process.env.WHATSAPP_ENGINE_TEST_ONLY} bypass=${process.env.MARKETING_TEST_BYPASS_SEND_WINDOW}`,
    );

    this._sending = true;
    try {
      const pending = await this.queueService.findPending(5);
      this.logger.log(
        `[MKT_PENDING_QUERY_RESULT] count=${pending.length} phones=${JSON.stringify(pending.map(p => p.customer_phone))} ids=${JSON.stringify(pending.map(p => p.id))}`,
      );
      this.logger.log(`[MKT_QUEUE_FETCHED] pending_count=${pending.length} ids=${JSON.stringify(pending.map(p => p.id))}`);
      const [item] = pending;
      if (item) {
        this.logger.log(
          `[MKT_QUEUE_ITEM_PROCESS] id=${item.id} phone=${item.customer_phone} ` +
          `template_id=${item.template_id ?? 'none'} scheduled_at=${item.scheduled_at?.toISOString()}`,
        );
        await this.processNext(item);
      } else {
        this.logger.log('[MKT_SENDER_TICK_SKIP] reason=queue_empty');
      }
    } catch (err: any) {
      this.logger.error(`[MKT_SCHEDULER_FATAL] tick crashed: ${err?.message}\n${err?.stack}`);
    } finally {
      this._sending = false;
    }
  }

  // Outer shell: guarantees [MKT_PROCESS_COMPLETE] fires regardless of outcome
  async processNext(item: WhatsappMessageQueue): Promise<void> {
    this.logger.log(
      `[MKT_PROCESS_START] id=${item.id} phone=${item.customer_phone} ` +
      `template_id=${item.template_id ?? 'none'} campaign_id=${item.campaign_id ?? 'none'} ` +
      `number_id=${item.number_id ?? 'none'} scheduled_at=${item.scheduled_at?.toISOString()}`,
    );
    try {
      await this._processNextInternal(item);
    } finally {
      this.logger.log(`[MKT_PROCESS_COMPLETE] id=${item.id} phone=${item.customer_phone}`);
    }
  }

  private async _processNextInternal(item: WhatsappMessageQueue): Promise<void> {
    await this.queueService.markProcessing(item.id);

    // logRow is written before any send attempt — guarantees DB visibility even on crash
    let logRow: WhatsappMessageLog | null = null;

    try {
      // ── Gate: TEST_ONLY ─────────────────────────────────────────────────────
      if (process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true') {
        const testPhones = await this.audienceService.getTestPhones();
        const matched = testPhones.includes(item.customer_phone);
        this.logger.log(
          `[MKT_TEST_CONTACT_MATCH] phone=${item.customer_phone} testPhones=${JSON.stringify(testPhones)} matched=${matched}`,
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

      // ── Gate: number limits ─────────────────────────────────────────────────
      const number = item.number_id
        ? await this.numbersService.findOne(item.number_id).catch(() => null)
        : null;

      if (number) {
        const limits = getActiveLimits(number.warmup_level);

        if (number.daily_sent >= limits.daily) {
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=DAILY_LIMIT reason="daily hard limit reached" ` +
            `condition_values="daily_sent=${number.daily_sent} limit=${limits.daily} warmup=${number.warmup_level}"`,
          );
          await this.queueService.markSkipped(item.id, `Daily hard limit reached (${limits.daily})`);
          await this.auditService.log({
            event: AuditEvent.HARD_LIMIT_HIT,
            number_id: number.id,
            customer_phone: item.customer_phone,
            template_id: item.template_id ?? undefined,
            campaign_id: item.campaign_id ?? undefined,
            reason: `daily_sent=${number.daily_sent} >= hard_limit=${limits.daily} (warmup=${number.warmup_level})`,
          });
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="DAILY_LIMIT: ${number.daily_sent}/${limits.daily}"`);
          return;
        }

        const oneHourAgo = new Date(Date.now() - 3_600_000);
        const sentLastHour = await this.logRepo
          .createQueryBuilder('l')
          .where('l.number_id = :nid', { nid: number.id })
          .andWhere('l.sent_at >= :oneHourAgo', { oneHourAgo })
          .andWhere('l.status != :failed', { failed: QueueStatus.FAILED })
          .getCount();

        if (sentLastHour >= limits.hourly) {
          this.logger.warn(
            `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
            `rule=HOURLY_CAP reason="hourly cap reached" ` +
            `condition_values="sent_last_hour=${sentLastHour} hourly_limit=${limits.hourly} warmup=${number.warmup_level}"`,
          );
          await this.queueService.markSkipped(item.id, `Hourly cap reached (${limits.hourly}/hr)`);
          await this.auditService.log({
            event: AuditEvent.HOURLY_CAP_HIT,
            number_id: number.id,
            customer_phone: item.customer_phone,
            template_id: item.template_id ?? undefined,
            reason: `sent_last_hour=${sentLastHour} >= hourly_cap=${limits.hourly}`,
          });
          this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=skipped attempts=${item.attempt_count ?? 0} failure_reason="HOURLY_CAP: ${sentLastHour}/${limits.hourly}"`);
          return;
        }
      }

      // ── Gate: content fingerprint ────────────────────────────────────────────
      if (item.template_id) {
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
      const body = await this._resolveBody(item);
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
        number_id: item.number_id ?? undefined,
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
        this._nextAllowedSend = new Date(Date.now() + humanDelay());
        this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent(dry_run) attempts=${item.attempt_count ?? 0} failure_reason="none"`);
        return;
      }

      if (!item.number_id) throw new Error('Queue item has no number_id — cannot send');

      // ── Actual WA send ───────────────────────────────────────────────────────
      this.logger.log(
        `[MKT_BEFORE_WA_SEND] id=${item.id} phone=${item.customer_phone} ` +
        `number_id=${item.number_id} body_length=${body.length} body_preview="${body.slice(0, 60)}"`,
      );

      let waResult: any;
      try {
        waResult = await this.whatsAppService.sendViaNumber(item.number_id, item.customer_phone, body);
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
          `condition_values="number_id=${item.number_id ?? 'none'}"`,
        );
        this.logger.warn(
          `[MKT_SKIP_DECISION] queue_id=${item.id} phone=${item.customer_phone} ` +
          `rule=WA_TRANSPORT reason="${errMsg}" ` +
          `condition_values="number_id=${item.number_id ?? 'none'} mapped_status=${mappedStatus}"`,
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

      await this.logRepo.update(logRow.id, {
        status: QueueStatus.SENT,
        sent_at: new Date(),
        wa_message_id: waMessageId ?? 'NO_ID_CHECK_LOGS',
      });
      this.logger.log(
        `[MKT_DB_LOG_WRITE] log_id=${logRow.id} updated status=sent wa_message_id=${waMessageId}`,
      );

      await this.queueService.markSent(item.id);
      this.logger.log(
        `[MKT_MARK_SENT] id=${item.id} phone=${item.customer_phone} wa_message_id=${waMessageId}`,
      );
      this.logger.log(
        `[MKT_SEND_SUCCESS] phone=${item.customer_phone} template_id=${item.template_id ?? 'none'} number_id=${item.number_id}`,
      );
      this.logger.log(`[MKT_FINAL_QUEUE_STATE] queue_id=${item.id} final_status=sent attempts=${item.attempt_count ?? 0} failure_reason="none"`);

      if (number) {
        await this.numbersService.incrementDailySent(number.id);
        await this.numbersService.updateLastMessageSent(number.id);
      }

      this._nextAllowedSend = new Date(Date.now() + humanDelay());

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

  private async _resolveBody(item: WhatsappMessageQueue): Promise<string | null> {
    if (item.template_id) {
      const template = await this.templatesService.findOne(item.template_id);
      const vars: Record<string, string> = {
        phone: item.customer_phone,
        ...(item.message_payload as Record<string, string> ?? {}),
      };
      return this.templatesService.interpolate(template.message_body, vars);
    }
    const payload = item.message_payload as Record<string, unknown> | null;
    if (payload?.['body']) return String(payload['body']);
    return null;
  }
}

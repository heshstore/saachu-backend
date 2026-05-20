import { Injectable, Logger } from '@nestjs/common';
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
export class SenderService {
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
  ) {}

  @Interval(15_000)
  async tick(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;
    if (this._sending) return;
    if (Date.now() < this._nextAllowedSend.getTime()) return; // human-like pause
    if (!this.whatsAppService.isAnyConnected()) return;
    if (!this.timingAi.isWithinSendWindow()) return;
    this._sending = true;
    try {
      const [item] = await this.queueService.findPending(1);
      if (item) await this.processNext(item);
    } catch (err: any) {
      this.logger.error(`[SENDER] tick error: ${err?.message}`);
    } finally {
      this._sending = false;
    }
  }

  async processNext(item: WhatsappMessageQueue): Promise<void> {
    await this.queueService.markProcessing(item.id);

    try {
      // TEST_ONLY mode — skip sends to non-test contacts
      if (process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true') {
        const testPhones = await this.audienceService.getTestPhones();
        if (!testPhones.includes(item.customer_phone)) {
          await this.queueService.markSkipped(item.id, 'TEST_ONLY mode: not a test contact');
          return;
        }
      }

      // Resolve the number entity for limit enforcement
      const number = item.number_id
        ? await this.numbersService.findOne(item.number_id).catch(() => null)
        : null;

      if (number) {
        const limits = getActiveLimits(number.warmup_level);

        // Hard daily limit check
        if (number.daily_sent >= limits.daily) {
          await this.queueService.markSkipped(item.id, `Daily hard limit reached (${limits.daily})`);
          await this.auditService.log({
            event: AuditEvent.HARD_LIMIT_HIT,
            number_id: number.id,
            customer_phone: item.customer_phone,
            template_id: item.template_id ?? undefined,
            campaign_id: item.campaign_id ?? undefined,
            reason: `daily_sent=${number.daily_sent} >= hard_limit=${limits.daily} (warmup=${number.warmup_level})`,
          });
          return;
        }

        // Hourly cap check
        const oneHourAgo = new Date(Date.now() - 3_600_000);
        const sentLastHour = await this.logRepo
          .createQueryBuilder('l')
          .where('l.number_id = :nid', { nid: number.id })
          .andWhere('l.sent_at >= :oneHourAgo', { oneHourAgo })
          .andWhere('l.status != :failed', { failed: QueueStatus.FAILED })
          .getCount();

        if (sentLastHour >= limits.hourly) {
          await this.queueService.markSkipped(item.id, `Hourly cap reached (${limits.hourly}/hr)`);
          await this.auditService.log({
            event: AuditEvent.HOURLY_CAP_HIT,
            number_id: number.id,
            customer_phone: item.customer_phone,
            template_id: item.template_id ?? undefined,
            reason: `sent_last_hour=${sentLastHour} >= hourly_cap=${limits.hourly}`,
          });
          return;
        }
      }

      // Content fingerprint — same template for same phone within last N days
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
              WHERE q.id = l.queue_id
                AND q.template_id = :tid
            )`,
            { tid: item.template_id },
          )
          .getCount();

        if (recentSame > 0) {
          await this.queueService.markSkipped(item.id, `Content fingerprint: same template sent recently`);
          await this.auditService.log({
            event: AuditEvent.FINGERPRINT_SKIP,
            number_id: item.number_id ?? undefined,
            customer_phone: item.customer_phone,
            template_id: item.template_id,
            reason: `Template already sent to this phone within ${CONTENT_FINGERPRINT_DAYS} days`,
          });
          return;
        }
      }

      const body = await this._resolveBody(item);
      if (body === null) {
        await this.queueService.markSkipped(item.id, 'No usable message body');
        return;
      }

      // Dry run — simulate without actually sending
      if (process.env.WHATSAPP_ENGINE_DRY_RUN === 'true') {
        this.logger.log(`[DRY_RUN] Would send to ${item.customer_phone}: ${body.slice(0, 80)}`);
        await this.queueService.markSent(item.id);
        await this.logRepo.save(
          this.logRepo.create({
            campaign_id: item.campaign_id ?? undefined,
            queue_id: item.id,
            number_id: item.number_id ?? undefined,
            customer_phone: item.customer_phone,
            message_type: MessageType.TEXT,
            message_body: body,
            status: QueueStatus.SENT,
            sent_at: new Date(),
            wa_message_id: 'DRY_RUN',
          }),
        );
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
        return;
      }

      if (!item.number_id) throw new Error('Queue item has no number_id — cannot send');
      await this.whatsAppService.sendViaNumber(item.number_id, item.customer_phone, body);
      await this.queueService.markSent(item.id);

      await this.logRepo.save(
        this.logRepo.create({
          campaign_id: item.campaign_id ?? undefined,
          queue_id: item.id,
          number_id: item.number_id ?? undefined,
          customer_phone: item.customer_phone,
          message_type: MessageType.TEXT,
          message_body: body,
          status: QueueStatus.SENT,
          sent_at: new Date(),
        }),
      );

      if (number) {
        await this.numbersService.incrementDailySent(number.id);
        await this.numbersService.updateLastMessageSent(number.id);
      }

      // Human-like pause before next send
      this._nextAllowedSend = new Date(Date.now() + humanDelay());

    } catch (err: any) {
      const msg: string = err?.message ?? 'Unknown error';
      this.logger.warn(`[SENDER] Failed ${item.customer_phone}: ${msg}`);
      await this.queueService.markFailed(item.id, msg);
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

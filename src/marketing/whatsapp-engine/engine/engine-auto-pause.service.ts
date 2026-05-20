import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { QueueStatus } from '../entities/enums';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

// Thresholds from Phase 9 spec
const CHECK_INTERVAL_MS      = 15 * 60 * 1000;  // check every 15 min
const WINDOW_MS              = 2 * 60 * 60 * 1000; // rolling 2-hour window
const MIN_SENDS_FOR_CHECK    = 10;  // need at least 10 data points before rate checks
const FAIL_RATE_THRESHOLD    = 35;  // % — pause if fail rate exceeds this
const DELIVERY_RATE_MIN      = 50;  // % — pause if delivery rate falls below this
const READ_RATE_MIN          = 40;  // % — pause if read rate falls below this
const MAX_DISCONNECTS_1H     = 3;   // repeated disconnects in 1 hour → pause

@Injectable()
export class EngineAutoPauseService {
  private readonly logger = new Logger(EngineAutoPauseService.name);
  private _disconnectTs: number[] = [];

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    private readonly auditService: EngineAuditService,
  ) {}

  @OnEvent('whatsapp.down')
  onWhatsAppDown(): void {
    const now = Date.now();
    this._disconnectTs.push(now);
    // Prune timestamps older than 1 hour
    const cutoff = now - 3_600_000;
    this._disconnectTs = this._disconnectTs.filter((t) => t >= cutoff);
    this.logger.log(`[AutoPause] WA disconnect recorded (${this._disconnectTs.length}/hr)`);
  }

  @Interval(CHECK_INTERVAL_MS)
  async runChecks(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;

    const trigger = await this._detectTrigger();
    if (!trigger) return;

    process.env.WHATSAPP_ENGINE_ENABLED = 'false';
    this.logger.warn(`[AUTO_ENGINE_PAUSE] Engine paused. Reason: ${trigger}`);

    await this.auditService.log({
      event: AuditEvent.AUTO_PAUSE,
      reason: trigger,
    });
  }

  private async _detectTrigger(): Promise<string | null> {
    // 1. Repeated disconnects
    if (this._disconnectTs.length >= MAX_DISCONNECTS_1H) {
      return `WhatsApp disconnected ${this._disconnectTs.length}x in last hour`;
    }

    const windowStart = new Date(Date.now() - WINDOW_MS);

    type Row = { status: string; count: string };
    const rows: Row[] = await this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.sent_at >= :windowStart', { windowStart })
      .groupBy('l.status')
      .getRawMany();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      counts[r.status] = n;
      total += n;
    }

    if (total < MIN_SENDS_FOR_CHECK) return null;

    const failed    = counts[QueueStatus.FAILED]    ?? 0;
    const delivered = counts[QueueStatus.DELIVERED] ?? 0;
    const read      = (counts[QueueStatus.READ]     ?? 0) + (counts[QueueStatus.REPLIED] ?? 0);
    const sent      = counts[QueueStatus.SENT]      ?? 0;

    const attemptTotal   = sent + delivered + failed;
    const deliveryRate   = attemptTotal > 0 ? (delivered / attemptTotal) * 100 : 100;
    const readBase       = delivered + read;
    const readRate       = readBase > 0 ? (read / readBase) * 100 : 100;
    const failRate       = total > 0 ? (failed / total) * 100 : 0;

    // 2. High fail rate
    if (failRate > FAIL_RATE_THRESHOLD) {
      return `Fail rate ${Math.round(failRate)}% > ${FAIL_RATE_THRESHOLD}% (${failed}/${total} in last 2h)`;
    }

    // 3. Delivery collapse — only check once we have enough delivered signals
    if (attemptTotal >= MIN_SENDS_FOR_CHECK && deliveryRate < DELIVERY_RATE_MIN) {
      return `Delivery collapsed: ${Math.round(deliveryRate)}% < ${DELIVERY_RATE_MIN}% (${delivered}/${attemptTotal} in last 2h)`;
    }

    // 4. Read collapse — only check once we have enough read signals
    if (readBase >= MIN_SENDS_FOR_CHECK && readRate < READ_RATE_MIN) {
      return `Read rate collapsed: ${Math.round(readRate)}% < ${READ_RATE_MIN}% (${read}/${readBase} in last 2h)`;
    }

    return null;
  }
}

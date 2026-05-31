import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { QueueStatus, WhatsAppNumberStatus } from '../entities/enums';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

// Thresholds from Phase 9 spec
const CHECK_INTERVAL_MS      = 15 * 60 * 1000;  // check every 15 min
const WINDOW_MS              = 2 * 60 * 60 * 1000; // rolling 2-hour window
const MIN_SENDS_FOR_CHECK    = 10;  // need at least 10 data points before rate checks
const FAIL_RATE_THRESHOLD    = 35;  // % — pause if fail rate exceeds this
const DELIVERY_RATE_MIN      = 50;  // % — pause if delivery rate falls below this
const READ_RATE_MIN          = 40;  // % — pause if read rate falls below this
const MAX_DISCONNECTS_1H     = 3;   // repeated disconnects for same number in 1 hour → pause

@Injectable()
export class EngineAutoPauseService {
  private readonly logger = new Logger(EngineAutoPauseService.name);

  // Per-number disconnect timestamps — keyed by numberId, values are epoch-ms timestamps
  private readonly _disconnectTsByNumber = new Map<string, number[]>();

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    private readonly auditService: EngineAuditService,
  ) {}

  // ── Disconnect tracking (per-number) ─────────────────────────────────────

  // Called by MarketingWhatsAppService when a marketing number disconnects.
  recordDisconnect(numberId: string): void {
    this.addDisconnect(numberId);
    this.pruneDisconnectHistory(numberId);
    const count = this.getDisconnectHistory(numberId).length;
    this.logger.log(`[AutoPause] Disconnect recorded numberId=${numberId} (${count}/hr)`);
  }

  private getDisconnectHistory(numberId: string): number[] {
    return this._disconnectTsByNumber.get(numberId) ?? [];
  }

  private addDisconnect(numberId: string): void {
    const arr = this._disconnectTsByNumber.get(numberId) ?? [];
    arr.push(Date.now());
    this._disconnectTsByNumber.set(numberId, arr);
  }

  private pruneDisconnectHistory(numberId: string): void {
    const cutoff = Date.now() - 3_600_000;
    const arr = this._disconnectTsByNumber.get(numberId) ?? [];
    this._disconnectTsByNumber.set(numberId, arr.filter((t) => t >= cutoff));
  }

  // ── Periodic check (per-number) ───────────────────────────────────────────

  @Interval(CHECK_INTERVAL_MS)
  async runChecks(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;

    // Prune disconnect history for all tracked numbers before checking
    for (const numberId of this._disconnectTsByNumber.keys()) {
      this.pruneDisconnectHistory(numberId);
    }

    const numbers = await this.numberRepo.find({ where: { is_active: true } });

    for (const number of numbers) {
      await this._checkNumber(number);
    }
  }

  private async _checkNumber(number: WhatsappNumber): Promise<void> {
    const trigger = await this._detectNumberTrigger(number.id, number.phone);
    if (!trigger) return;

    // Pause only this number — never the engine
    await this.numberRepo.update(number.id, {
      is_active: false,
      status: WhatsAppNumberStatus.INACTIVE,
    });

    this.logger.warn(
      `[RISK_NUMBER_PAUSED] ${JSON.stringify({ numberId: number.id, phone: number.phone, reason: trigger, ts: new Date().toISOString() })}`,
    );

    await this.auditService.log({
      event: AuditEvent.AUTO_PAUSE,
      number_id: number.id,
      reason: trigger,
    });
  }

  private async _detectNumberTrigger(numberId: string, phone: string): Promise<string | null> {
    // 1. Repeated disconnects for this specific number
    const disconnects = this.getDisconnectHistory(numberId).length;
    if (disconnects >= MAX_DISCONNECTS_1H) {
      return `Number ${phone} disconnected ${disconnects}x in last hour`;
    }

    const windowStart = new Date(Date.now() - WINDOW_MS);

    type Row = { status: string; count: string };
    const rows: Row[] = await this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.number_id = :numberId', { numberId })
      .andWhere('l.sent_at >= :windowStart', { windowStart })
      .groupBy('l.status')
      .getRawMany();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      counts[r.status] = n;
      total += n;
    }

    const failed    = counts[QueueStatus.FAILED]    ?? 0;
    const delivered = counts[QueueStatus.DELIVERED] ?? 0;
    const read      = (counts[QueueStatus.READ]     ?? 0) + (counts[QueueStatus.REPLIED] ?? 0);
    const sent      = counts[QueueStatus.SENT]      ?? 0;

    const attemptTotal = sent + delivered + failed;
    const deliveryRate = attemptTotal > 0 ? (delivered / attemptTotal) * 100 : 100;
    const readBase     = delivered + read;
    const readRate     = readBase > 0 ? (read / readBase) * 100 : 100;
    const failRate     = total > 0 ? (failed / total) * 100 : 0;

    this.logger.log(
      `[RISK_NUMBER_METRICS] ${JSON.stringify({
        numberId,
        phone,
        total,
        failRate: Math.round(failRate),
        deliveryRate: Math.round(deliveryRate),
        readRate: Math.round(readRate),
        disconnects,
        windowHours: WINDOW_MS / 3_600_000,
        ts: new Date().toISOString(),
      })}`,
    );

    if (total < MIN_SENDS_FOR_CHECK) return null;

    // 2. High fail rate
    if (failRate > FAIL_RATE_THRESHOLD) {
      return `Number ${phone} fail rate ${Math.round(failRate)}% > ${FAIL_RATE_THRESHOLD}% (${failed}/${total} in last 2h)`;
    }

    // 3. Delivery collapse
    if (attemptTotal >= MIN_SENDS_FOR_CHECK && deliveryRate < DELIVERY_RATE_MIN) {
      return `Number ${phone} delivery collapsed: ${Math.round(deliveryRate)}% < ${DELIVERY_RATE_MIN}% (${delivered}/${attemptTotal} in last 2h)`;
    }

    // 4. Read collapse
    if (readBase >= MIN_SENDS_FOR_CHECK && readRate < READ_RATE_MIN) {
      return `Number ${phone} read rate collapsed: ${Math.round(readRate)}% < ${READ_RATE_MIN}% (${read}/${readBase} in last 2h)`;
    }

    return null;
  }
}

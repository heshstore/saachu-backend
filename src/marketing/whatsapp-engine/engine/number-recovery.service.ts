import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsAppNumberStatus } from '../entities/enums';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

// A paused number must have been inactive for this many days before recovery is attempted
const MIN_COOLING_DAYS = 3;
// Historical fail rate must be below this to qualify for recovery
const RECOVERY_MAX_FAIL_RATE = 20; // %
// Minimum historical sends needed to evaluate
const MIN_HISTORY_SENDS = 5;
// On recovery, daily_limit is restored at this fraction of the original limit
const RECOVERY_LIMIT_FRACTION = 0.5;
// Minimum daily_limit to restore to (avoid restoring to < 10)
const RECOVERY_MIN_LIMIT = 10;

@Injectable()
export class NumberRecoveryService {
  private readonly logger = new Logger(NumberRecoveryService.name);
  private _running = false;

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly auditService: EngineAuditService,
  ) {}

  // Daily check at 06:00 — before the queue builds at 08:30
  @Cron('0 6 * * *')
  async recoverNumbers(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;
    if (this._running) {
      this.logger.warn('[NumberRecovery] Previous run still in progress — skipping cron tick');
      return;
    }
    this._running = true;
    try {
      await this._recoverNumbersInternal();
    } finally {
      this._running = false;
    }
  }

  private async _recoverNumbersInternal(): Promise<void> {
    const coolingCutoff = new Date(Date.now() - MIN_COOLING_DAYS * 86_400_000);

    // Find numbers that are inactive and have been cooling long enough
    const candidates = await this.numberRepo
      .createQueryBuilder('n')
      .where('n.is_active = false')
      .andWhere('n.status = :s', { s: WhatsAppNumberStatus.INACTIVE })
      .andWhere(
        '(n.last_message_sent_at IS NULL OR n.last_message_sent_at <= :cutoff)',
        { cutoff: coolingCutoff },
      )
      .getMany();

    if (!candidates.length) return;

    this.logger.log(`[NumberRecovery] Checking ${candidates.length} inactive number(s) for recovery`);

    for (const number of candidates) {
      await this._evaluateAndRecover(number);
    }
  }

  private async _evaluateAndRecover(number: WhatsappNumber): Promise<void> {
    type Row = { status: string; count: string };
    const historyRows: Row[] = await this.ds.query(
      `SELECT status, COUNT(*) AS count
       FROM whatsapp_message_logs
       WHERE number_id = $1
       GROUP BY status`,
      [number.id],
    );

    let total = 0;
    let failed = 0;
    for (const r of historyRows) {
      const n = parseInt(r.count, 10);
      total += n;
      if (r.status === 'failed') failed = n;
    }

    if (total < MIN_HISTORY_SENDS) {
      this.logger.log(`[NumberRecovery] ${number.phone}: insufficient history (${total} sends) — skipping`);
      return;
    }

    const failRate = (failed / total) * 100;
    if (failRate > RECOVERY_MAX_FAIL_RATE) {
      this.logger.log(
        `[NumberRecovery] ${number.phone}: fail rate ${Math.round(failRate)}% > ${RECOVERY_MAX_FAIL_RATE}% — not recovering`,
      );
      return;
    }

    // Restore at reduced capacity — do NOT jump straight to old limit
    const restoredLimit = Math.max(
      RECOVERY_MIN_LIMIT,
      Math.floor(number.daily_limit * RECOVERY_LIMIT_FRACTION),
    );

    await this.numberRepo.update(number.id, {
      is_active: true,
      status: WhatsAppNumberStatus.ACTIVE,
      daily_limit: restoredLimit,
      risk_score: 0,
    });

    this.logger.log(
      `[NumberRecovery] Restored ${number.phone}: daily_limit=${restoredLimit} warmup_level=${number.warmup_level} (fail_rate=${Math.round(failRate)}%)`,
    );

    await this.auditService.log({
      event: AuditEvent.NUMBER_RECOVERED,
      number_id: number.id,
      reason: `Gradual recovery after ${MIN_COOLING_DAYS}d cooling — fail_rate=${Math.round(failRate)}%, restored limit=${restoredLimit}`,
    });
  }
}

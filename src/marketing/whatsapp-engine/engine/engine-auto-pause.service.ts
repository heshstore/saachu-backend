import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { EngineAuditService, AuditEvent } from './engine-audit.service';
import { WarmupProgressionService } from './warmup-progression.service';
import { detectWarnings } from '../shared/warmup-health';

// Warnings only — never pause, deactivate, or stop sending.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours (no short-window checks)

@Injectable()
export class EngineAutoPauseService {
  private readonly logger = new Logger(EngineAutoPauseService.name);
  private readonly _lastWarningAt = new Map<string, number>();

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    private readonly auditService: EngineAuditService,
    private readonly warmupProgression: WarmupProgressionService,
  ) {}

  // Disconnect tracking for operational logs only — does not affect sending.
  recordDisconnect(numberId: string): void {
    this.logger.log(`[HealthWarning] Disconnect recorded numberId=${numberId} (informational only)`);
  }

  @Interval(CHECK_INTERVAL_MS)
  async runChecks(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;

    const numbers = await this.numberRepo.find({ where: { is_active: true } });
    for (const number of numbers) {
      await this._checkNumber(number);
    }
  }

  private async _checkNumber(number: WhatsappNumber): Promise<void> {
    const metrics = await this.warmupProgression.getHealthMetrics(number.id);
    const warnings = detectWarnings(metrics);
    if (!warnings.length) return;

    const dedupeKey = `${number.id}:${warnings.join(',')}`;
    const lastAt = this._lastWarningAt.get(dedupeKey) ?? 0;
    if (Date.now() - lastAt < 24 * 60 * 60 * 1000) return;
    this._lastWarningAt.set(dedupeKey, Date.now());

    for (const kind of warnings) {
      const event = kind as AuditEvent;
      const reason = this._warningReason(number.phone, kind, metrics);
      this.logger.warn(`[RISK_NUMBER_WARNING] ${JSON.stringify({ numberId: number.id, phone: number.phone, event, reason })}`);
      await this.auditService.log({ event, number_id: number.id, reason, metadata: { ...metrics, window_days: 7 } });
    }
  }

  private _warningReason(phone: string, kind: string, m: { deliveryRatePct: number; failRatePct: number; total: number }): string {
    switch (kind) {
      case 'LOW_DELIVERY_WARNING':
        return `Number ${phone} 7d delivery ${m.deliveryRatePct}% or fail ${m.failRatePct}% (${m.total} sends)`;
      default:
        return `Number ${phone} health warning`;
    }
  }
}

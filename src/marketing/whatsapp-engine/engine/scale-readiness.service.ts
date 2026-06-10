import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { QueueStatus, WhatsAppNumberStatus } from '../entities/enums';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

// Step 8 thresholds from Phase 10 spec
const STABILITY_DAYS       = 14;   // must be running without ban for this many days
const MIN_DELIVERY_RATE    = 60;   // %
const MIN_READ_RATE        = 20;   // %
const MIN_REPLY_RATE       = 5;    // %
const MAX_FAIL_RATE        = 20;   // %
const MAX_FATIGUE_PCT      = 20;   // % of audience with fatigue_score >= 50
const MAX_COOLDOWN_PCT     = 30;   // % of audience in cooldown
const MIN_SENDS_FOR_RATES  = 20;   // minimum historical sends required to evaluate rates

// Controlled scale stages (MAX_DAILY_AUDIENCE)
const SCALE_STAGES = [25, 40, 60] as const;
const SCALE_STAGE_LABELS: Record<number, string> = {
  25: 'Stage 1 → 40/day',
  40: 'Stage 2 → 60/day',
  60: 'Stage 3 → activate second number (manual action in admin panel)',
};

export interface ConditionResult {
  pass: boolean;
  detail: string;
}

export interface ReadinessReport {
  verdict: 'GO' | 'NO_GO';
  ready: boolean;
  current_max_daily: number;
  next_stage: number | 'SECOND_NUMBER';
  conditions: Record<string, ConditionResult>;
  checked_at: string;
}

@Injectable()
export class ScaleReadinessService {
  private readonly logger = new Logger(ScaleReadinessService.name);

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly whatsAppService: MarketingWhatsAppService,
    private readonly auditService: EngineAuditService,
  ) {}

  async checkReadiness(): Promise<ReadinessReport> {
    const current = parseInt(process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE ?? '25', 10);
    const nextStage = this._nextStage(current);

    const since14 = new Date(Date.now() - STABILITY_DAYS * 86_400_000);

    const [logRows, warningRows, numbers, audienceRows] = await Promise.all([
      this._getLogRates(since14),
      this._getWarningCount(since14),
      this.numberRepo.find(),
      this._getAudienceStats(),
    ]);

    const rates        = this._computeRates(logRows);
    const warningCount = parseInt(warningRows[0]?.count ?? '0', 10);
    const banned       = numbers.some((n) => n.status === WhatsAppNumberStatus.BANNED);
    const waUp         = this.whatsAppService.isAnyConnected();

    const aud = (audienceRows[0] ?? {}) as {
      total?: string; in_cooldown?: string; high_fatigue?: string;
    };
    const audTotal    = parseInt(aud.total        ?? '0', 10);
    const inCooldown  = parseInt(aud.in_cooldown  ?? '0', 10);
    const highFatigue = parseInt(aud.high_fatigue ?? '0', 10);
    const cooldownPct  = audTotal > 0 ? (inCooldown  / audTotal) * 100 : 0;
    const fatiguePct   = audTotal > 0 ? (highFatigue / audTotal) * 100 : 0;

    const hasEnoughData = rates.attempted >= MIN_SENDS_FOR_RATES;

    const conditions: Record<string, ConditionResult> = {
      stable_14_days: {
        pass: true,
        detail: warningCount === 0
          ? `No delivery/read warning events in last ${STABILITY_DAYS} days`
          : `${warningCount} delivery/read warning event(s) in last ${STABILITY_DAYS} days — warning only, no automatic pause`,
      },
      no_bans: {
        pass: !banned,
        detail: banned ? 'One or more numbers are BANNED' : 'No banned numbers',
      },
      healthy_delivery: {
        pass: !hasEnoughData || rates.delivery_rate_pct >= MIN_DELIVERY_RATE,
        detail: hasEnoughData
          ? `Delivery rate: ${rates.delivery_rate_pct}% (min ${MIN_DELIVERY_RATE}%)`
          : `Insufficient data (${rates.attempted} sends, need ${MIN_SENDS_FOR_RATES})`,
      },
      healthy_reads: {
        pass: !hasEnoughData || rates.read_rate_pct >= MIN_READ_RATE,
        detail: hasEnoughData
          ? `Read rate: ${rates.read_rate_pct}% (min ${MIN_READ_RATE}%)`
          : `Insufficient data`,
      },
      healthy_replies: {
        pass: !hasEnoughData || rates.reply_rate_pct >= MIN_REPLY_RATE,
        detail: hasEnoughData
          ? `Reply rate: ${rates.reply_rate_pct}% (min ${MIN_REPLY_RATE}%)`
          : `Insufficient data`,
      },
      stable_session: {
        pass: waUp,
        detail: waUp ? 'WhatsApp session connected' : 'WhatsApp is not connected',
      },
      low_fail_rate: {
        pass: !hasEnoughData || rates.fail_rate_pct <= MAX_FAIL_RATE,
        detail: hasEnoughData
          ? `Fail rate: ${rates.fail_rate_pct}% (max ${MAX_FAIL_RATE}%)`
          : `Insufficient data`,
      },
      low_fatigue_growth: {
        pass: fatiguePct <= MAX_FATIGUE_PCT,
        detail: `${Math.round(fatiguePct)}% of audience has high fatigue (max ${MAX_FATIGUE_PCT}%)`,
      },
      low_cooldown_growth: {
        pass: cooldownPct <= MAX_COOLDOWN_PCT,
        detail: `${Math.round(cooldownPct)}% of audience in cooldown (max ${MAX_COOLDOWN_PCT}%)`,
      },
    };

    const ready = Object.values(conditions).every((c) => c.pass);

    return {
      verdict:          ready ? 'GO' : 'NO_GO',
      ready,
      current_max_daily: current,
      next_stage:        nextStage,
      conditions,
      checked_at:        new Date().toISOString(),
    };
  }

  // Only scales up if all conditions pass. Returns the new limit or a reason for refusal.
  async scaleUp(): Promise<{ success: boolean; message: string; new_limit?: number }> {
    const report = await this.checkReadiness();

    if (!report.ready) {
      const failed = Object.entries(report.conditions)
        .filter(([, v]) => !v.pass)
        .map(([k]) => k)
        .join(', ');
      return {
        success: false,
        message: `Scale-up refused — NOT_READY. Failing conditions: ${failed}`,
      };
    }

    const current = report.current_max_daily;
    const next = report.next_stage;

    if (next === 'SECOND_NUMBER') {
      return {
        success: false,
        message: 'Already at 60/day — next step is activating a second number. This is a manual action: add a new WhatsAppNumber record in admin panel.',
      };
    }

    process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE = String(next);
    this.logger.log(`[ScaleUp] MAX_DAILY_AUDIENCE: ${current} → ${next}`);

    await this.auditService.log({
      event: AuditEvent.SCALE_UP,
      reason: `Controlled scale-up: ${current}/day → ${next}/day. All ${Object.keys(report.conditions).length} readiness conditions passed.`,
      metadata: { previous: current, next, stage_label: SCALE_STAGE_LABELS[current] ?? '' },
    });

    return {
      success: true,
      message: `Scaled up: ${current}/day → ${next}/day. Note: update WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE=${next} in .env to persist across restarts.`,
      new_limit: next,
    };
  }

  private _nextStage(current: number): number | 'SECOND_NUMBER' {
    const idx = SCALE_STAGES.indexOf(current as (typeof SCALE_STAGES)[number]);
    if (idx === -1 || idx >= SCALE_STAGES.length - 1) return 'SECOND_NUMBER';
    return SCALE_STAGES[idx + 1];
  }

  private async _getLogRates(since: Date) {
    return this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.sent_at >= :since', { since })
      .groupBy('l.status')
      .getRawMany<{ status: string; count: string }>();
  }

  private _computeRates(rows: { status: string; count: string }[]) {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = parseInt(r.count, 10);
    const sent      = c[QueueStatus.SENT]      ?? 0;
    const delivered = c[QueueStatus.DELIVERED] ?? 0;
    const read      = (c[QueueStatus.READ]     ?? 0) + (c[QueueStatus.REPLIED] ?? 0);
    const replied   = c[QueueStatus.REPLIED]   ?? 0;
    const failed    = c[QueueStatus.FAILED]    ?? 0;
    const attempted = sent + delivered + failed;
    return {
      attempted,
      delivery_rate_pct: attempted > 0 ? Math.round((delivered / attempted) * 100) : 0,
      read_rate_pct:     (sent + delivered) > 0 ? Math.round((read / (sent + delivered)) * 100) : 0,
      reply_rate_pct:    (sent + delivered) > 0 ? Math.round((replied / (sent + delivered)) * 100) : 0,
      fail_rate_pct:     attempted > 0 ? Math.round((failed / attempted) * 100) : 0,
    };
  }

  private async _getWarningCount(since: Date) {
    try {
      return this.ds.query<{ count: string }[]>(
        `SELECT COUNT(*) AS count
         FROM engine_audit_logs
         WHERE event IN ('LOW_DELIVERY_WARNING', 'LOW_READ_WARNING')
           AND created_at >= $1`,
        [since],
      );
    } catch { return [{ count: '0' }]; }
  }

  private async _getAudienceStats() {
    return this.ds.query<{ total: string; in_cooldown: string; high_fatigue: string }[]>(`
      SELECT
        COUNT(*)                                                                       AS total,
        COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW())  AS in_cooldown,
        COUNT(*) FILTER (WHERE fatigue_score >= 50)                                    AS high_fatigue
      FROM marketing_audience
      WHERE opt_out = false
    `);
  }
}

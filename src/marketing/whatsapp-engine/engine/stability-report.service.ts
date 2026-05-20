import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { QueueStatus, WhatsAppNumberStatus } from '../entities/enums';

export interface DailyTrendRow {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  delivery_rate_pct: number;
  read_rate_pct: number;
  reply_rate_pct: number;
  fail_rate_pct: number;
}

export interface StabilityReport {
  period_days: number;
  since: string;

  // Aggregate funnel over the period
  totals: {
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
    delivery_rate_pct: number;
    read_rate_pct: number;
    reply_rate_pct: number;
    fail_rate_pct: number;
  };

  // Day-by-day trend
  daily_trend: DailyTrendRow[];

  // Operational events from audit log (all 6 governance signals from Phase 11 Step 8)
  events: {
    auto_pause_count: number;
    auto_pause_reasons: string[];
    number_recovered_count: number;
    scale_up_count: number;
    manual_reenable_count: number;
    fingerprint_skip_count: number;  // high count = template diversity too low
    hard_limit_hit_count: number;    // high count = audience growing faster than number capacity
  };

  // Audience health
  audience: {
    total: number;
    in_cooldown: number;
    opted_out: number;
    high_fatigue: number;           // fatigue_score >= 50
    cooldown_pct: number;
    high_fatigue_pct: number;
  };

  // Number health
  numbers: {
    active: number;
    inactive: number;
    banned: number;
    avg_risk_score: number;
  };

  // Stability verdict
  verdict: {
    stable: boolean;
    issues: string[];
  };
}

@Injectable()
export class StabilityReportService {
  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async getReport(days = 14): Promise<StabilityReport> {
    const since = new Date(Date.now() - days * 86_400_000);

    const [totalsRows, dailyRows, auditRows, audienceRows, numberRows] = await Promise.all([
      this._getTotals(since),
      this._getDailyTrend(since),
      this._getAuditEvents(since),
      this._getAudienceHealth(),
      this._getNumberHealth(),
    ]);

    const totals = this._buildTotals(totalsRows);
    const daily = this._buildDailyTrend(dailyRows);

    const autoPauses      = auditRows.filter((r: any) => r.event === 'AUTO_PAUSE');
    const recoveries      = auditRows.filter((r: any) => r.event === 'NUMBER_RECOVERED');
    const scaleUps        = auditRows.filter((r: any) => r.event === 'SCALE_UP');
    const manualReEnables = auditRows.filter((r: any) => r.event === 'MANUAL_REENABLE');
    const fingerprintSkips = auditRows.filter((r: any) => r.event === 'FINGERPRINT_SKIP');
    const hardLimitHits   = auditRows.filter((r: any) => r.event === 'HARD_LIMIT_HIT');

    const audience = (audienceRows[0] ?? {}) as {
      total?: string; in_cooldown?: string; opted_out?: string; high_fatigue?: string;
    };
    const total      = parseInt(audience.total       ?? '0', 10);
    const inCooldown = parseInt(audience.in_cooldown  ?? '0', 10);
    const optedOut   = parseInt(audience.opted_out    ?? '0', 10);
    const highFatigue = parseInt(audience.high_fatigue ?? '0', 10);

    const numbers = numberRows;

    // Stability verdict
    const issues: string[] = [];
    if (autoPauses.length > 0)
      issues.push(`${autoPauses.length} AUTO_PAUSE event(s) in last ${days} days — investigate before scaling`);
    if (totals.fail_rate_pct > 25)
      issues.push(`Elevated fail rate: ${totals.fail_rate_pct}%`);
    if (totals.delivery_rate_pct < 50 && totals.sent > 20)
      issues.push(`Low delivery rate: ${totals.delivery_rate_pct}%`);
    if (totals.read_rate_pct < 10 && totals.sent > 20)
      issues.push(`Low read rate: ${totals.read_rate_pct}%`);
    if (total > 0 && (inCooldown / total) > 0.40)
      issues.push(`High cooldown ratio: ${Math.round((inCooldown / total) * 100)}% of audience in cooldown`);
    if (total > 0 && (highFatigue / total) > 0.30)
      issues.push(`High fatigue: ${Math.round((highFatigue / total) * 100)}% of audience has fatigue_score ≥ 50`);
    if (numbers.banned > 0)
      issues.push(`${numbers.banned} banned number(s) — immediate attention required`);
    if (numbers.avg_risk_score > 50)
      issues.push(`High average number risk score: ${numbers.avg_risk_score}`);

    // Operational drift signals (Phase 11 Step 8)
    const fpSkipRate = totals.sent > 0 ? fingerprintSkips.length / totals.sent : 0;
    if (fpSkipRate > 0.30)
      issues.push(`High FINGERPRINT_SKIP rate: ${fingerprintSkips.length} skips / ${totals.sent} sends — add more template diversity`);
    if (hardLimitHits.length > days * 3)
      issues.push(`Frequent HARD_LIMIT_HIT: ${hardLimitHits.length} events — audience is outgrowing number capacity, consider activating second number`);

    return {
      period_days: days,
      since: since.toISOString().slice(0, 10),
      totals,
      daily_trend: daily,
      events: {
        auto_pause_count:       autoPauses.length,
        auto_pause_reasons:     autoPauses.map((r: any) => r.reason ?? '').filter(Boolean),
        number_recovered_count: recoveries.length,
        scale_up_count:         scaleUps.length,
        manual_reenable_count:  manualReEnables.length,
        fingerprint_skip_count: fingerprintSkips.length,
        hard_limit_hit_count:   hardLimitHits.length,
      },
      audience: {
        total,
        in_cooldown: inCooldown,
        opted_out:   optedOut,
        high_fatigue: highFatigue,
        cooldown_pct:     total > 0 ? Math.round((inCooldown  / total) * 100) : 0,
        high_fatigue_pct: total > 0 ? Math.round((highFatigue / total) * 100) : 0,
      },
      numbers,
      verdict: { stable: issues.length === 0, issues },
    };
  }

  private async _getTotals(since: Date) {
    return this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.sent_at >= :since', { since })
      .groupBy('l.status')
      .getRawMany<{ status: string; count: string }>();
  }

  private _buildTotals(rows: { status: string; count: string }[]) {
    const c: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      c[r.status] = n;
      total += n;
    }
    const sent      = c[QueueStatus.SENT]      ?? 0;
    const delivered = c[QueueStatus.DELIVERED] ?? 0;
    const read      = (c[QueueStatus.READ]     ?? 0) + (c[QueueStatus.REPLIED] ?? 0);
    const replied   = c[QueueStatus.REPLIED]   ?? 0;
    const failed    = c[QueueStatus.FAILED]    ?? 0;
    const attempted = sent + delivered + failed;
    return {
      sent:              total - failed,
      delivered,
      read,
      replied,
      failed,
      delivery_rate_pct: attempted > 0 ? Math.round((delivered / attempted) * 100) : 0,
      read_rate_pct:     (sent + delivered) > 0 ? Math.round((read / (sent + delivered)) * 100) : 0,
      reply_rate_pct:    (sent + delivered) > 0 ? Math.round((replied / (sent + delivered)) * 100) : 0,
      fail_rate_pct:     attempted > 0 ? Math.round((failed / attempted) * 100) : 0,
    };
  }

  private async _getDailyTrend(since: Date) {
    return this.ds.query<{
      day: string; sent: string; delivered: string;
      read: string; replied: string; failed: string;
    }[]>(`
      SELECT
        TO_CHAR(l.sent_at::DATE, 'YYYY-MM-DD')                              AS day,
        COUNT(*) FILTER (WHERE l.status = 'sent')                           AS sent,
        COUNT(*) FILTER (WHERE l.status = 'delivered')                      AS delivered,
        COUNT(*) FILTER (WHERE l.status IN ('read','replied'))              AS read,
        COUNT(*) FILTER (WHERE l.status = 'replied')                        AS replied,
        COUNT(*) FILTER (WHERE l.status = 'failed')                         AS failed
      FROM whatsapp_message_logs l
      WHERE l.sent_at >= $1
      GROUP BY 1
      ORDER BY 1 ASC
    `, [since]);
  }

  private _buildDailyTrend(rows: {
    day: string; sent: string; delivered: string;
    read: string; replied: string; failed: string;
  }[]): DailyTrendRow[] {
    return rows.map((r) => {
      const sent      = parseInt(r.sent,      10);
      const delivered = parseInt(r.delivered, 10);
      const read      = parseInt(r.read,      10);
      const replied   = parseInt(r.replied,   10);
      const failed    = parseInt(r.failed,    10);
      const attempted = sent + delivered + failed;
      return {
        date: r.day,
        sent,
        delivered,
        read,
        replied,
        failed,
        delivery_rate_pct: attempted > 0 ? Math.round((delivered / attempted) * 100) : 0,
        read_rate_pct:     (sent + delivered) > 0 ? Math.round((read / (sent + delivered)) * 100) : 0,
        reply_rate_pct:    (sent + delivered) > 0 ? Math.round((replied / (sent + delivered)) * 100) : 0,
        fail_rate_pct:     attempted > 0 ? Math.round((failed / attempted) * 100) : 0,
      };
    });
  }

  private async _getAuditEvents(since: Date) {
    try {
      return this.ds.query<{ event: string; reason: string | null }[]>(
        `SELECT event, reason FROM engine_audit_logs
         WHERE event IN (
           'AUTO_PAUSE', 'NUMBER_RECOVERED',
           'SCALE_UP', 'MANUAL_REENABLE',
           'FINGERPRINT_SKIP', 'HARD_LIMIT_HIT'
         )
         AND created_at >= $1
         ORDER BY created_at DESC`,
        [since],
      );
    } catch { return []; }
  }

  private async _getAudienceHealth() {
    return this.ds.query<{
      total: string; in_cooldown: string; opted_out: string; high_fatigue: string;
    }[]>(`
      SELECT
        COUNT(*)                                                                        AS total,
        COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW())  AS in_cooldown,
        COUNT(*) FILTER (WHERE opt_out = true)                                         AS opted_out,
        COUNT(*) FILTER (WHERE fatigue_score >= 50)                                    AS high_fatigue
      FROM marketing_audience
    `);
  }

  private async _getNumberHealth(): Promise<{
    active: number; inactive: number; banned: number; avg_risk_score: number;
  }> {
    const rows = await this.numberRepo.find();
    const active   = rows.filter((n) => n.is_active && n.status === WhatsAppNumberStatus.ACTIVE).length;
    const inactive = rows.filter((n) => !n.is_active).length;
    const banned   = rows.filter((n) => n.status === WhatsAppNumberStatus.BANNED).length;
    const avgRisk  = rows.length > 0
      ? Math.round(rows.reduce((s, n) => s + Number(n.risk_score), 0) / rows.length)
      : 0;
    return { active, inactive, banned, avg_risk_score: avgRisk };
  }
}

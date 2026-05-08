import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { KpiSnapshot } from './entities/kpi-snapshot.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationType, NotificationPriority, NotificationCategory } from '../notifications/notification.entity';

// ── Alert thresholds ─────────────────────────────────────────────────────────

const THRESHOLDS = {
  sla_compliance_rate:    { min: 80,  severity: NotificationPriority.CRITICAL },
  whatsapp_uptime_percent:{ min: 95,  severity: NotificationPriority.HIGH     },
  avg_response_minutes:   { max: 30,  severity: NotificationPriority.HIGH     },
  delayed_job_rate:       { max: 20,  severity: NotificationPriority.HIGH     },
};

// ── Period helpers ────────────────────────────────────────────────────────────

function periodBounds(daysBack: number): { from: Date; to: Date } {
  const to   = new Date();
  const from = new Date(Date.now() - daysBack * 86_400_000);
  return { from, to };
}

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SalesMetrics {
  leads_total:               number;
  leads_contacted:           number;
  avg_response_minutes:      number | null;
  quotations_sent:           number;
  quotation_conversion_rate: number;
  followup_completion_rate:  number;
  sla_compliance_rate:       number;
  by_user?: UserSalesMetric[];
}

export interface UserSalesMetric {
  user_id:      number;
  user_name:    string;
  leads:        number;
  followups:    number;
  quotations:   number;
  conversions:  number;
}

export interface ProductionMetrics {
  jobs_completed:          number;
  avg_completion_hours:    number | null;
  delayed_job_rate:        number;
  active_jobs:             number;
  sla_compliance_rate:     number;
}

export interface AccountsMetrics {
  total_revenue:        number;
  total_outstanding:    number;
  avg_collection_days:  number | null;
  overdue_rate:         number;
  today_collection:     number;
}

export interface DispatchMetrics {
  total_dispatches:     number;
  avg_dispatch_hours:   number | null;
  ontime_rate:          number;
  delivered:            number;
}

export interface SystemMetrics {
  whatsapp_uptime_percent: number;
  sla_breach_rate:         number;
  escalation_count:        number;
  automation_actions:      number;
}

export interface LeaderboardEntry {
  user_id:   number;
  user_name: string;
  value:     number;
  unit?:     string;
  rank:      number;
}

export interface KpiSummary {
  sales:      SalesMetrics;
  production: ProductionMetrics;
  accounts:   AccountsMetrics;
  dispatch:   DispatchMetrics;
  system:     SystemMetrics;
  period:     { from: Date; to: Date; label: string };
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class KpiEngineService {
  private readonly logger = new Logger(KpiEngineService.name);

  constructor(
    @InjectRepository(KpiSnapshot)
    private readonly snapshotRepo: Repository<KpiSnapshot>,
    private readonly dataSource: DataSource,
    private readonly notifService: NotificationService,
  ) {}

  private q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.dataSource.query<T[]>(sql, params);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  async getSummary(daysBack = 30): Promise<KpiSummary> {
    const { from, to } = periodBounds(daysBack);
    const [sales, production, accounts, dispatch, system] = await Promise.all([
      this.computeSalesMetrics(from, to),
      this.computeProductionMetrics(from, to),
      this.computeAccountsMetrics(from, to),
      this.computeDispatchMetrics(from, to),
      this.computeSystemMetrics(from, to),
    ]);
    return {
      sales, production, accounts, dispatch, system,
      period: { from, to, label: daysBack === 7 ? 'Last 7 days' : daysBack === 30 ? 'Last 30 days' : `Last ${daysBack} days` },
    };
  }

  async getUserSummary(userId: number, daysBack = 30): Promise<SalesMetrics> {
    const { from, to } = periodBounds(daysBack);
    return this.computeSalesMetrics(from, to, userId);
  }

  // ── Sales metrics ─────────────────────────────────────────────────────────────

  async computeSalesMetrics(from: Date, to: Date, userId?: number): Promise<SalesMetrics> {
    const userFilter = userId ? `AND l.assigned_to = ${userId}` : '';
    const actFilter  = userId ? `AND a.performed_by_user_id = ${userId}` : '';

    const [leadRows, responseRows, quotationRows, followupRows, slaRows, userRows] =
      await Promise.all([
        // Lead totals
        this.q(`
          SELECT
            COUNT(*)::int                                          AS leads_total,
            COUNT(*) FILTER (WHERE l.status != 'NEW')::int        AS leads_contacted
          FROM leads l
          WHERE l.created_at BETWEEN $1 AND $2 AND l.is_active = true ${userFilter}
        `, [from, to]),

        // Avg first response time (minutes): time from lead creation to first STATUS_CHANGED activity
        this.q(`
          SELECT AVG(EXTRACT(EPOCH FROM (a.created_at - l.created_at)) / 60)::numeric AS avg_minutes
          FROM leads l
          JOIN (
            SELECT entity_id, MIN(created_at) AS created_at
            FROM activity_logs
            WHERE action = 'STATUS_CHANGED' AND entity_type = 'lead'
            ${actFilter.replace('AND a.', 'AND ')}
            GROUP BY entity_id
          ) a ON a.entity_id = l.id
          WHERE l.created_at BETWEEN $1 AND $2 AND l.is_active = true ${userFilter}
        `, [from, to]),

        // Quotation metrics
        this.q(`
          SELECT
            COUNT(*)::int                                                                          AS total,
            COUNT(*) FILTER (WHERE status IN ('SENT','APPROVED','CONVERTED'))::int                AS sent,
            COUNT(*) FILTER (WHERE status IN ('APPROVED','CONVERTED'))::float /
              NULLIF(COUNT(*) FILTER (WHERE status IN ('SENT','APPROVED','CONVERTED')), 0) * 100  AS conversion_rate
          FROM quotations
          WHERE created_at BETWEEN $1 AND $2
          ${userId ? `AND created_by = ${userId}` : ''}
        `, [from, to]),

        // Follow-up completion
        this.q(`
          SELECT
            COUNT(*) FILTER (WHERE lf.is_completed = true)::float /
              NULLIF(COUNT(*), 0) * 100 AS completion_rate
          FROM lead_followups lf
          WHERE lf.due_date BETWEEN $1 AND $2
          ${userId ? `AND lf.created_by = ${userId}` : ''}
        `, [from, to]),

        // SLA compliance (leads resolved without escalation / total CRM SLAs)
        this.q(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'RESOLVED' AND escalation_level = 0)::float /
              NULLIF(COUNT(*), 0) * 100 AS compliance_rate
          FROM sla_events
          WHERE module = 'CRM' AND created_at BETWEEN $1 AND $2
        `, [from, to]),

        // Per-user breakdown (skipped if single user query)
        userId ? Promise.resolve([]) : this.q(`
          SELECT
            u.id                                                        AS user_id,
            u.name                                                      AS user_name,
            COUNT(DISTINCT l.id)::int                                   AS leads,
            COUNT(DISTINCT lf.id) FILTER (WHERE lf.is_completed)::int  AS followups,
            COUNT(DISTINCT q.id)::int                                   AS quotations,
            COUNT(DISTINCT q.id) FILTER (WHERE q.status IN ('APPROVED','CONVERTED'))::int AS conversions
          FROM users u
          LEFT JOIN leads l       ON l.assigned_to = u.id AND l.created_at BETWEEN $1 AND $2 AND l.is_active = true
          LEFT JOIN lead_followups lf ON lf.created_by = u.id AND lf.due_date BETWEEN $1 AND $2
          LEFT JOIN quotations q   ON q.created_by  = u.id AND q.created_at BETWEEN $1 AND $2
          WHERE u.is_active = true AND u.role IN ('Admin','Sales Manager','Salesman','COO')
          GROUP BY u.id, u.name
          HAVING COUNT(DISTINCT l.id) > 0 OR COUNT(DISTINCT q.id) > 0
          ORDER BY leads DESC
          LIMIT 20
        `, [from, to]),
      ]);

    const lr = leadRows[0]    ?? {};
    const rr = responseRows[0] ?? {};
    const qr = quotationRows[0] ?? {};
    const fr = followupRows[0] ?? {};
    const sr = slaRows[0]     ?? {};

    return {
      leads_total:               Number(lr.leads_total ?? 0),
      leads_contacted:           Number(lr.leads_contacted ?? 0),
      avg_response_minutes:      rr.avg_minutes != null ? Math.round(Number(rr.avg_minutes)) : null,
      quotations_sent:           Number(qr.sent ?? 0),
      quotation_conversion_rate: Math.round(Number(qr.conversion_rate ?? 0) * 10) / 10,
      followup_completion_rate:  Math.round(Number(fr.completion_rate ?? 0) * 10) / 10,
      sla_compliance_rate:       Math.round(Number(sr.compliance_rate ?? 0) * 10) / 10,
      by_user: (userRows as any[]).map(r => ({
        user_id:     Number(r.user_id),
        user_name:   r.user_name,
        leads:       Number(r.leads),
        followups:   Number(r.followups),
        quotations:  Number(r.quotations),
        conversions: Number(r.conversions),
      })),
    };
  }

  // ── Production metrics ────────────────────────────────────────────────────────

  async computeProductionMetrics(from: Date, to: Date): Promise<ProductionMetrics> {
    const [jobRows, slaRows] = await Promise.all([
      this.q(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at BETWEEN $1 AND $2)::int         AS completed,
          COUNT(*) FILTER (WHERE status IN ('PENDING','IN_PROGRESS'))::int                         AS active,
          COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('DONE','CANCELLED'))::int     AS delayed,
          COUNT(*) FILTER (WHERE status NOT IN ('CANCELLED'))::int                                 AS total,
          AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)
            FILTER (WHERE status = 'DONE' AND completed_at BETWEEN $1 AND $2)::numeric             AS avg_hours
        FROM production_jobs
        WHERE created_at BETWEEN $1 AND $2
      `, [from, to]),

      this.q(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'RESOLVED' AND escalation_level = 0)::float /
            NULLIF(COUNT(*), 0) * 100 AS compliance_rate
        FROM sla_events
        WHERE module = 'PRODUCTION' AND created_at BETWEEN $1 AND $2
      `, [from, to]),
    ]);

    const jr = jobRows[0] ?? {};
    const sr = slaRows[0] ?? {};

    const total   = Number(jr.total   ?? 1);
    const delayed = Number(jr.delayed ?? 0);

    return {
      jobs_completed:       Number(jr.completed ?? 0),
      avg_completion_hours: jr.avg_hours != null ? Math.round(Number(jr.avg_hours) * 10) / 10 : null,
      delayed_job_rate:     total > 0 ? Math.round((delayed / total) * 1000) / 10 : 0,
      active_jobs:          Number(jr.active ?? 0),
      sla_compliance_rate:  Math.round(Number(sr.compliance_rate ?? 0) * 10) / 10,
    };
  }

  // ── Accounts metrics ──────────────────────────────────────────────────────────

  async computeAccountsMetrics(from: Date, to: Date): Promise<AccountsMetrics> {
    const [orderRows, collectionRows, todayRows] = await Promise.all([
      this.q(`
        SELECT
          COALESCE(SUM(total_amount),   0)::numeric  AS revenue,
          COALESCE(SUM(pending_amount), 0)::numeric  AS outstanding,
          COUNT(*) FILTER (WHERE pending_amount > 0 AND status NOT IN ('CANCELLED','REJECTED'))::int AS overdue_count,
          COUNT(*) FILTER (WHERE status NOT IN ('CANCELLED','REJECTED'))::int                        AS total_count
        FROM orders
        WHERE created_at BETWEEN $1 AND $2
      `, [from, to]),

      // Avg days from order creation to full payment
      this.q(`
        SELECT AVG(EXTRACT(EPOCH FROM (p.created_at - o.created_at)) / 86400)::numeric AS avg_days
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.created_at BETWEEN $1 AND $2
          AND o.pending_amount = 0
      `, [from, to]),

      this.q(`
        SELECT COALESCE(SUM(amount), 0)::numeric AS today
        FROM payments
        WHERE created_at::date = CURRENT_DATE
      `, []),
    ]);

    const or  = orderRows[0]      ?? {};
    const cr  = collectionRows[0] ?? {};
    const tr  = todayRows[0]      ?? {};

    const total   = Number(or.total_count ?? 1);
    const overdue = Number(or.overdue_count ?? 0);

    return {
      total_revenue:       Number(or.revenue      ?? 0),
      total_outstanding:   Number(or.outstanding  ?? 0),
      avg_collection_days: cr.avg_days != null ? Math.round(Number(cr.avg_days) * 10) / 10 : null,
      overdue_rate:        total > 0 ? Math.round((overdue / total) * 1000) / 10 : 0,
      today_collection:    Number(tr.today ?? 0),
    };
  }

  // ── Dispatch metrics ──────────────────────────────────────────────────────────

  async computeDispatchMetrics(from: Date, to: Date): Promise<DispatchMetrics> {
    const [rows] = await Promise.all([
      this.q(`
        SELECT
          COUNT(*)::int                                                         AS total,
          COUNT(*) FILTER (WHERE dispatch_status = 'DELIVERED')::int           AS delivered,
          AVG(EXTRACT(EPOCH FROM (d.dispatch_date - o.created_at)) / 3600)
            FILTER (WHERE d.dispatch_date IS NOT NULL)::numeric                AS avg_hours,
          COUNT(*) FILTER (
            WHERE s.status NOT IN ('ESCALATED') OR s.id IS NULL
          )::float / NULLIF(COUNT(*), 0) * 100                                 AS ontime_rate
        FROM dispatches d
        JOIN orders o ON o.id = d.order_id
        LEFT JOIN sla_events s ON s.entity_type = 'dispatch' AND s.entity_id = d.id
        WHERE d.created_at BETWEEN $1 AND $2
      `, [from, to]),
    ]);

    const r = rows[0] ?? {};

    return {
      total_dispatches:   Number(r.total     ?? 0),
      avg_dispatch_hours: r.avg_hours != null ? Math.round(Number(r.avg_hours) * 10) / 10 : null,
      ontime_rate:        Math.round(Number(r.ontime_rate ?? 0) * 10) / 10,
      delivered:          Number(r.delivered ?? 0),
    };
  }

  // ── System metrics ────────────────────────────────────────────────────────────

  async computeSystemMetrics(from: Date, to: Date): Promise<SystemMetrics> {
    const periodMs = to.getTime() - from.getTime();

    const [slaRows, waRows, automationRows] = await Promise.all([
      this.q(`
        SELECT
          COUNT(*)::int                                         AS total,
          COUNT(*) FILTER (WHERE status = 'ESCALATED')::int   AS breached,
          COUNT(*) FILTER (WHERE escalation_level >= 2)::int  AS admin_escalations
        FROM sla_events
        WHERE created_at BETWEEN $1 AND $2
      `, [from, to]),

      // Approximate WhatsApp uptime: subtract downtime windows between DOWN→UP pairs
      this.q(`
        SELECT
          COALESCE(SUM(EXTRACT(EPOCH FROM (up.created_at - down.created_at))), 0)::numeric AS downtime_seconds
        FROM (
          SELECT created_at,
                 LEAD(created_at) OVER (ORDER BY created_at) AS next_up
          FROM activity_logs
          WHERE action = 'WHATSAPP_DOWN' AND created_at BETWEEN $1 AND $2
        ) down
        JOIN activity_logs up ON up.action = 'WHATSAPP_UP'
          AND up.created_at > down.created_at
          AND (down.next_up IS NULL OR up.created_at < down.next_up)
          AND up.created_at BETWEEN $1 AND $2
      `, [from, to]),

      this.q(`
        SELECT COUNT(*)::int AS count
        FROM activity_logs
        WHERE source = 'AUTOMATION' AND created_at BETWEEN $1 AND $2
      `, [from, to]),
    ]);

    const sr = slaRows[0]       ?? {};
    const wr = waRows[0]        ?? {};
    const ar = automationRows[0] ?? {};

    const downtimeSeconds = Number(wr.downtime_seconds ?? 0);
    const uptimePct       = periodMs > 0
      ? Math.max(0, Math.min(100, (1 - downtimeSeconds * 1000 / periodMs) * 100))
      : 100;

    const slaTotal   = Number(sr.total    ?? 1);
    const slaBreached = Number(sr.breached ?? 0);

    return {
      whatsapp_uptime_percent: Math.round(uptimePct * 10) / 10,
      sla_breach_rate:         slaTotal > 0 ? Math.round((slaBreached / slaTotal) * 1000) / 10 : 0,
      escalation_count:        Number(sr.admin_escalations ?? 0),
      automation_actions:      Number(ar.count ?? 0),
    };
  }

  // ── Leaderboard ───────────────────────────────────────────────────────────────

  async getLeaderboard(metric: string, daysBack = 30): Promise<LeaderboardEntry[]> {
    const { from, to } = periodBounds(daysBack);

    const queries: Record<string, string> = {
      followup_completion: `
        SELECT u.id AS user_id, u.name AS user_name,
               COUNT(*) FILTER (WHERE lf.is_completed) AS value
        FROM users u
        LEFT JOIN lead_followups lf ON lf.created_by = u.id AND lf.due_date BETWEEN $1 AND $2
        WHERE u.is_active = true
        GROUP BY u.id, u.name
        HAVING COUNT(*) > 0
        ORDER BY value DESC LIMIT 10
      `,
      leads_handled: `
        SELECT u.id AS user_id, u.name AS user_name, COUNT(DISTINCT l.id) AS value
        FROM users u
        LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at BETWEEN $1 AND $2 AND l.is_active = true
        WHERE u.is_active = true
        GROUP BY u.id, u.name
        HAVING COUNT(DISTINCT l.id) > 0
        ORDER BY value DESC LIMIT 10
      `,
      response_time: `
        SELECT u.id AS user_id, u.name AS user_name,
               AVG(EXTRACT(EPOCH FROM (a.created_at - l.created_at)) / 60)::numeric AS value
        FROM users u
        JOIN leads l ON l.assigned_to = u.id AND l.created_at BETWEEN $1 AND $2 AND l.is_active = true
        JOIN (
          SELECT entity_id, MIN(created_at) AS created_at FROM activity_logs
          WHERE action = 'STATUS_CHANGED' AND entity_type = 'lead' GROUP BY entity_id
        ) a ON a.entity_id = l.id
        WHERE u.is_active = true
        GROUP BY u.id, u.name
        HAVING COUNT(l.id) >= 3
        ORDER BY value ASC LIMIT 10
      `,
      jobs_completed: `
        SELECT u.id AS user_id, u.name AS user_name, COUNT(*) AS value
        FROM users u
        JOIN production_jobs j ON j.assigned_to = u.id
          AND j.status = 'DONE' AND j.completed_at BETWEEN $1 AND $2
        WHERE u.is_active = true
        GROUP BY u.id, u.name
        HAVING COUNT(*) > 0
        ORDER BY value DESC LIMIT 10
      `,
      quotation_conversion: `
        SELECT u.id AS user_id, u.name AS user_name,
               COALESCE(
                 COUNT(*) FILTER (WHERE q.status IN ('APPROVED','CONVERTED'))::float /
                 NULLIF(COUNT(*) FILTER (WHERE q.status IN ('SENT','APPROVED','CONVERTED')), 0) * 100,
                 0
               )::numeric AS value
        FROM users u
        LEFT JOIN quotations q ON q.created_by = u.id AND q.created_at BETWEEN $1 AND $2
        WHERE u.is_active = true
        GROUP BY u.id, u.name
        HAVING COUNT(q.id) >= 2
        ORDER BY value DESC LIMIT 10
      `,
    };

    const sql = queries[metric];
    if (!sql) return [];

    try {
      const rows = await this.q(sql, [from, to]);
      return rows.map((r: any, i) => ({
        user_id:   Number(r.user_id),
        user_name: r.user_name,
        value:     Math.round(Number(r.value ?? 0) * 10) / 10,
        rank:      i + 1,
      }));
    } catch (e: any) {
      this.logger.warn(`Leaderboard query '${metric}' failed: ${e?.message?.slice(0, 100)}`);
      return [];
    }
  }

  // ── Historical snapshots for trend charts ─────────────────────────────────────

  async getHistoricalSnapshots(module: string, metricKey: string, daysBack = 30): Promise<any[]> {
    return this.q(`
      SELECT period_start, metric_value, metric_unit, period
      FROM kpi_snapshots
      WHERE module = $1 AND metric_key = $2 AND scope = 'SYSTEM'
        AND period = 'DAILY'
        AND period_start >= NOW() - INTERVAL '1 day' * $3
      ORDER BY period_start ASC
    `, [module, metricKey, daysBack]);
  }

  // ── Nightly snapshot cron ─────────────────────────────────────────────────────

  @Cron('0 0 2 * * *') // 02:00 every night
  async nightlySnapshot(): Promise<void> {
    this.logger.log('KPI nightly snapshot starting…');
    try {
      const yesterday = new Date(Date.now() - 86_400_000);
      const from      = startOfDay(yesterday);
      const to        = endOfDay(yesterday);

      await this.computeAndStoreSnapshots('DAILY', from, to);

      // Weekly: every Monday
      if (new Date().getDay() === 1) {
        const wFrom = new Date(Date.now() - 7 * 86_400_000);
        await this.computeAndStoreSnapshots('WEEKLY', startOfDay(wFrom), endOfDay(yesterday));
      }

      // Monthly: 1st of the month
      if (new Date().getDate() === 1) {
        const mFrom = new Date(Date.now() - 30 * 86_400_000);
        await this.computeAndStoreSnapshots('MONTHLY', startOfDay(mFrom), endOfDay(yesterday));
      }

      this.logger.log('KPI nightly snapshot complete');
    } catch (e: any) {
      this.logger.error(`KPI nightly snapshot failed: ${e?.message}`);
    }
  }

  private async computeAndStoreSnapshots(period: 'DAILY' | 'WEEKLY' | 'MONTHLY', from: Date, to: Date): Promise<void> {
    const [sales, production, accounts, dispatch, system] = await Promise.all([
      this.computeSalesMetrics(from, to),
      this.computeProductionMetrics(from, to),
      this.computeAccountsMetrics(from, to),
      this.computeDispatchMetrics(from, to),
      this.computeSystemMetrics(from, to),
    ]);

    const snapshots: Array<{
      module: string; key: string; value: number; unit: string;
      meta?: Record<string, any>;
    }> = [
      // SALES
      { module: 'SALES', key: 'leads_total',               value: sales.leads_total,               unit: 'count' },
      { module: 'SALES', key: 'leads_contacted',           value: sales.leads_contacted,            unit: 'count' },
      { module: 'SALES', key: 'avg_response_minutes',      value: sales.avg_response_minutes ?? 0,  unit: 'minutes' },
      { module: 'SALES', key: 'quotations_sent',           value: sales.quotations_sent,             unit: 'count' },
      { module: 'SALES', key: 'quotation_conversion_rate', value: sales.quotation_conversion_rate,   unit: '%' },
      { module: 'SALES', key: 'followup_completion_rate',  value: sales.followup_completion_rate,    unit: '%' },
      { module: 'SALES', key: 'sla_compliance_rate',       value: sales.sla_compliance_rate,         unit: '%' },
      // PRODUCTION
      { module: 'PRODUCTION', key: 'jobs_completed',          value: production.jobs_completed,          unit: 'count' },
      { module: 'PRODUCTION', key: 'avg_completion_hours',    value: production.avg_completion_hours ?? 0, unit: 'hours' },
      { module: 'PRODUCTION', key: 'delayed_job_rate',        value: production.delayed_job_rate,        unit: '%' },
      { module: 'PRODUCTION', key: 'sla_compliance_rate',     value: production.sla_compliance_rate,     unit: '%' },
      // ACCOUNTS
      { module: 'ACCOUNTS', key: 'total_revenue',        value: accounts.total_revenue,        unit: 'INR' },
      { module: 'ACCOUNTS', key: 'total_outstanding',    value: accounts.total_outstanding,    unit: 'INR' },
      { module: 'ACCOUNTS', key: 'avg_collection_days',  value: accounts.avg_collection_days ?? 0, unit: 'days' },
      { module: 'ACCOUNTS', key: 'overdue_rate',         value: accounts.overdue_rate,         unit: '%' },
      // DISPATCH
      { module: 'DISPATCH', key: 'total_dispatches',   value: dispatch.total_dispatches,   unit: 'count' },
      { module: 'DISPATCH', key: 'avg_dispatch_hours', value: dispatch.avg_dispatch_hours ?? 0, unit: 'hours' },
      { module: 'DISPATCH', key: 'ontime_rate',        value: dispatch.ontime_rate,         unit: '%' },
      // SYSTEM
      { module: 'SYSTEM', key: 'whatsapp_uptime_percent', value: system.whatsapp_uptime_percent, unit: '%' },
      { module: 'SYSTEM', key: 'sla_breach_rate',         value: system.sla_breach_rate,         unit: '%' },
      { module: 'SYSTEM', key: 'escalation_count',        value: system.escalation_count,        unit: 'count' },
    ];

    for (const s of snapshots) {
      try {
        await this.snapshotRepo
          .createQueryBuilder()
          .insert()
          .into(KpiSnapshot)
          .values({
            scope:        'SYSTEM',
            scope_id:     null,
            module:       s.module,
            metric_key:   s.key,
            metric_value: s.value,
            metric_unit:  s.unit,
            period,
            period_start: from,
            period_end:   to,
            metadata:     s.meta ?? null,
          })
          .orUpdate(['metric_value', 'metric_unit', 'metadata'], ['scope', 'scope_id', 'module', 'metric_key', 'period', 'period_start'])
          .execute();
      } catch {} // Skip individual failures — don't break the whole batch
    }

    // Check thresholds and alert
    await this.checkAlerts({ sales, production, system });
  }

  // ── KPI Alerts ────────────────────────────────────────────────────────────────

  private async checkAlerts(metrics: {
    sales: SalesMetrics; production: ProductionMetrics; system: SystemMetrics;
  }): Promise<void> {
    const checks: Array<{ metric: string; value: number; label: string; module: any }> = [
      { metric: 'sla_compliance_rate',     value: metrics.sales.sla_compliance_rate,         label: 'Sales SLA compliance',    module: NotificationCategory.CRM },
      { metric: 'sla_compliance_rate',     value: metrics.production.sla_compliance_rate,    label: 'Production SLA compliance', module: NotificationCategory.PRODUCTION },
      { metric: 'whatsapp_uptime_percent', value: metrics.system.whatsapp_uptime_percent,    label: 'WhatsApp uptime',          module: NotificationCategory.SYSTEM },
      { metric: 'avg_response_minutes',    value: metrics.sales.avg_response_minutes ?? 0,   label: 'Lead response time',       module: NotificationCategory.CRM },
      { metric: 'delayed_job_rate',        value: metrics.production.delayed_job_rate,        label: 'Delayed job rate',         module: NotificationCategory.PRODUCTION },
    ];

    for (const check of checks) {
      const threshold = THRESHOLDS[check.metric as keyof typeof THRESHOLDS];
      if (!threshold) continue;

      const breached =
        ('min' in threshold && check.value < threshold.min) ||
        ('max' in threshold && check.value > (threshold as any).max);

      if (!breached) continue;

      await this.notifService.createRoleNotification(['Admin'], {
        type:            NotificationType.ACTION,
        priority:        threshold.severity,
        category:        check.module,
        title:           `KPI Alert: ${check.label}`,
        message:         `${check.label} is at ${check.value}${check.metric.includes('rate') || check.metric.includes('percent') ? '%' : check.metric.includes('minutes') ? ' min' : ''}. Review required.`,
        action_url:      '/kpi',
        cooldownMinutes: 360, // 6h cooldown — one alert per KPI per reporting cycle
        is_automated:    true,
      }).catch(() => {});
    }
  }
}

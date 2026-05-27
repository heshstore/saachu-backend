import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { TrackEventDto } from './dto/track-event.dto';
import { LogsService, LogAction } from '../logs/logs.service';
import { getSyncStatus } from '../shopify/shopify.service';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly repo: Repository<AnalyticsEvent>,
    private readonly dataSource: DataSource,
    private readonly logsService: LogsService,
  ) {}

  private async ensureTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id         SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        event      TEXT NOT NULL,
        product    TEXT,
        page_url   TEXT NOT NULL,
        device     TEXT,
        city       TEXT,
        source     TEXT,
        timestamp  TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_event   ON analytics_events(event)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_product ON analytics_events(product) WHERE product IS NOT NULL`,
    );
  }

  async track(dto: TrackEventDto): Promise<{ success: boolean }> {
    await this.ensureTable();

    const record = this.repo.create({
      session_id: dto.session_id,
      event:      dto.event,
      product:    dto.product    ?? null,
      page_url:   dto.page_url,
      device:     dto.device     ?? null,
      city:       dto.city       ?? null,
      source:     dto.source     ?? null,
      timestamp:  dto.timestamp  ? new Date(dto.timestamp) : null,
    });
    await this.repo.save(record);
    this.logsService.log(LogAction.ANALYTICS_TRACKED, { event: dto.event, product: dto.product ?? null, session_id: dto.session_id });
    return { success: true };
  }

  async findAll(): Promise<AnalyticsEvent[]> {
    return this.repo.find({ order: { created_at: 'DESC' }, take: 500 });
  }

  async getSummary(): Promise<{
    total_events: number;
    page_views: number;
    product_views: number;
    whatsapp_clicks: number;
    exit_popup: number;
  }> {
    const rows: { event: string; count: string }[] = await this.dataSource.query(`
      SELECT event, COUNT(*)::int AS count
      FROM analytics_events
      GROUP BY event
    `);

    const map: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      map[r.event] = Number(r.count);
      total += Number(r.count);
    }

    return {
      total_events:    total,
      page_views:      map['page_view']      ?? 0,
      product_views:   map['product_view']   ?? 0,
      whatsapp_clicks: map['whatsapp_click'] ?? 0,
      exit_popup:      map['exit_popup']     ?? 0,
    };
  }

  async getTopProducts(): Promise<{ product: string; total_views: number; whatsapp_clicks: number }[]> {
    const rows: { product: string; event: string; count: string }[] = await this.dataSource.query(`
      SELECT product, event, COUNT(*)::int AS count
      FROM analytics_events
      WHERE product IS NOT NULL
        AND product <> ''
        AND event IN ('product_view', 'whatsapp_click')
      GROUP BY product, event
      ORDER BY product
    `);

    const map: Record<string, { total_views: number; whatsapp_clicks: number }> = {};
    for (const r of rows) {
      if (!map[r.product]) map[r.product] = { total_views: 0, whatsapp_clicks: 0 };
      if (r.event === 'product_view')   map[r.product].total_views      += Number(r.count);
      if (r.event === 'whatsapp_click') map[r.product].whatsapp_clicks  += Number(r.count);
    }

    return Object.entries(map)
      .map(([product, stats]) => ({ product, ...stats }))
      .sort((a, b) => b.total_views - a.total_views)
      .slice(0, 10);
  }

  async getSourceBreakdown(): Promise<{ source: string; count: number }[]> {
    const rows: { source: string; count: string }[] = await this.dataSource.query(`
      SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS count
      FROM analytics_events
      GROUP BY COALESCE(source, 'unknown')
      ORDER BY count DESC
    `);

    return rows.map(r => ({ source: r.source, count: Number(r.count) }));
  }

  // ── Phase 4: Operational KPIs ─────────────────────────────────────────────

  async getOperationalKpis() {
    const safe = async (sql: string, params: any[] = []) => {
      try { return await this.dataSource.query(sql, params); } catch { return []; }
    };

    const [quotRows, orderRows, approvalRows, dispatchRows, collectionRows,
           overdueRows, prodRows, waRows, leadRows, syncRows] = await Promise.all([
      safe(`SELECT COUNT(*)::int AS count FROM quotation WHERE created_at::date = CURRENT_DATE`),
      safe(`SELECT COUNT(*)::int AS count FROM orders WHERE created_at::date = CURRENT_DATE AND status <> 'CANCELLED'`),
      safe(`SELECT COUNT(*)::int AS count FROM orders WHERE status = 'PENDING_APPROVAL'`),
      safe(`SELECT COUNT(*)::int AS count FROM orders WHERE status = 'READY'`),
      safe(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE created_at::date = CURRENT_DATE`),
      safe(`SELECT COUNT(*)::int AS count FROM orders WHERE status = 'DISPATCHED' AND pending_amount > 0`),
      safe(`SELECT COUNT(*)::int AS count FROM production_jobs WHERE status IN ('PENDING','IN_PROGRESS')`),
      safe(`SELECT status FROM whatsapp_sessions ORDER BY last_active_at DESC LIMIT 1`),
      safe(`SELECT COUNT(*)::int AS count FROM leads WHERE status NOT IN ('WON','LOST','CANCELLED','REJECTED')`),
      safe(`SELECT MAX(updated_at) AS last_sync FROM shopify_catalog_items`),
    ]);

    const waStatus: string = waRows[0]?.status ?? 'NO_SESSION';
    // Prefer in-process lastSuccessfulSyncAt (accurate even for no-change syncs),
    // fall back to DB MAX(updated_at) if server was just restarted.
    let shopifySyncMinutes: number | null = null;
    const verifiedAt = getSyncStatus().lastSuccessfulSyncAt ?? syncRows[0]?.last_sync ?? null;
    if (verifiedAt) {
      shopifySyncMinutes = Math.round((Date.now() - new Date(verifiedAt).getTime()) / 60_000);
    }

    return {
      quotations_today:      Number(quotRows[0]?.count     ?? 0),
      orders_today:          Number(orderRows[0]?.count    ?? 0),
      pending_approvals:     Number(approvalRows[0]?.count ?? 0),
      pending_dispatch:      Number(dispatchRows[0]?.count ?? 0),
      collections_today:     Number(collectionRows[0]?.total ?? 0),
      overdue_payments:      Number(overdueRows[0]?.count  ?? 0),
      production_pending:    Number(prodRows[0]?.count     ?? 0),
      whatsapp_status:       waStatus,
      shopify_sync_minutes:  shopifySyncMinutes,
      active_leads:          Number(leadRows[0]?.count     ?? 0),
    };
  }

  async getSalesAnalytics(days = 30) {
    const safe = async (sql: string, params: any[] = []) => {
      try { return await this.dataSource.query(sql, params); } catch { return []; }
    };
    const from = new Date(Date.now() - days * 86_400_000).toISOString();

    const [quotRows, convRows, leadRows, followupRows] = await Promise.all([
      safe(`SELECT COUNT(*)::int AS sent FROM quotation WHERE created_at >= $1`, [from]),
      safe(`SELECT COUNT(*)::int AS converted FROM quotation WHERE status = 'CONVERTED' AND updated_at >= $1`, [from]),
      safe(`SELECT COUNT(*)::int AS total FROM leads WHERE created_at >= $1`, [from]),
      safe(`
        SELECT
          COUNT(*) FILTER (WHERE completed = true)::int  AS done,
          COUNT(*)::int                                   AS total
        FROM lead_followups WHERE scheduled_at >= $1
      `, [from]),
    ]);

    const sent      = Number(quotRows[0]?.sent      ?? 0);
    const converted = Number(convRows[0]?.converted ?? 0);
    const leads     = Number(leadRows[0]?.total     ?? 0);
    const fuDone    = Number(followupRows[0]?.done  ?? 0);
    const fuTotal   = Number(followupRows[0]?.total ?? 0);

    return {
      period_days:              days,
      quotations_sent:          sent,
      quotations_converted:     converted,
      conversion_rate:          sent > 0 ? Math.round((converted / sent) * 100) : 0,
      leads_total:              leads,
      followup_completion_rate: fuTotal > 0 ? Math.round((fuDone / fuTotal) * 100) : null,
    };
  }

  async getProductionAnalytics(days = 30) {
    const safe = async (sql: string, params: any[] = []) => {
      try { return await this.dataSource.query(sql, params); } catch { return []; }
    };
    const from = new Date(Date.now() - days * 86_400_000).toISOString();

    const [summaryRows, activeRows] = await Promise.all([
      safe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DONE')::int           AS completed,
          COUNT(*) FILTER (WHERE status = 'DONE' AND due_date IS NOT NULL AND completed_at > due_date)::int AS delayed,
          AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600)::numeric AS avg_hours
        FROM production_jobs WHERE created_at >= $1
      `, [from]),
      safe(`SELECT COUNT(*)::int AS count FROM production_jobs WHERE status IN ('PENDING','IN_PROGRESS')`),
    ]);

    const s = summaryRows[0] ?? {};
    const completed = Number(s.completed ?? 0);
    const delayed   = Number(s.delayed   ?? 0);

    return {
      period_days:      days,
      jobs_completed:   completed,
      jobs_delayed:     delayed,
      delayed_rate:     completed > 0 ? Math.round((delayed / completed) * 100) : 0,
      avg_hours:        s.avg_hours != null ? Number(Number(s.avg_hours).toFixed(1)) : null,
      active_jobs:      Number(activeRows[0]?.count ?? 0),
    };
  }

  async getNotificationsSummary(userId?: number) {
    const safe = async (sql: string, params: any[] = []) => {
      try { return await this.dataSource.query(sql, params); } catch { return []; }
    };

    if (userId) {
      const rows = await safe(`
        SELECT
          COUNT(*) FILTER (WHERE is_read = false)::int AS unread,
          COUNT(*) FILTER (WHERE priority IN ('CRITICAL','HIGH') AND is_read = false)::int AS urgent,
          COUNT(*)::int AS total_active
        FROM notifications WHERE user_id = $1 AND is_active = true
      `, [userId]);
      return {
        unread:   Number(rows[0]?.unread  ?? 0),
        urgent:   Number(rows[0]?.urgent  ?? 0),
        total:    Number(rows[0]?.total_active ?? 0),
      };
    }

    const rows = await safe(`
      SELECT
        COUNT(*) FILTER (WHERE is_read = false)::int AS unread,
        COUNT(*) FILTER (WHERE priority IN ('CRITICAL','HIGH'))::int AS urgent
      FROM notifications WHERE is_active = true AND created_at >= NOW() - INTERVAL '24 hours'
    `);
    return {
      unread_24h: Number(rows[0]?.unread ?? 0),
      urgent_24h: Number(rows[0]?.urgent ?? 0),
    };
  }

  async getSystemHealth() {
    const safe = async (sql: string) => {
      try { return await this.dataSource.query(sql); } catch { return []; }
    };

    const [dbRows, waRows, syncRows, jobRows, schedulerRows] = await Promise.all([
      safe(`SELECT 1 AS ok`),
      safe(`SELECT status, last_active_at FROM whatsapp_sessions ORDER BY last_active_at DESC LIMIT 1`),
      safe(`SELECT MAX(updated_at) AS last_sync, COUNT(*)::int AS total FROM shopify_catalog_items`),
      safe(`SELECT COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at::date = CURRENT_DATE)::int AS jobs_today FROM production_jobs`),
      safe(`SELECT COUNT(*)::int AS count FROM kpi_snapshots WHERE created_at >= NOW() - INTERVAL '2 hours'`),
    ]);

    const waRow   = waRows[0];
    const syncRow = syncRows[0];

    let shopifySyncMinutes: number | null = null;
    const verifiedAt2 = getSyncStatus().lastSuccessfulSyncAt ?? syncRow?.last_sync ?? null;
    if (verifiedAt2) {
      shopifySyncMinutes = Math.round((Date.now() - new Date(verifiedAt2).getTime()) / 60_000);
    }

    const waConnected = waRow?.status === 'AUTHENTICATED' || waRow?.status === 'CONNECTED';

    return {
      database:            dbRows.length > 0 ? 'connected' : 'error',
      whatsapp_status:     waRow?.status ?? 'NO_SESSION',
      whatsapp_connected:  waConnected,
      whatsapp_last_seen:  waRow?.last_active_at ?? null,
      shopify_sync_minutes: shopifySyncMinutes,
      shopify_catalog_size: Number(syncRow?.total ?? 0),
      scheduler_active:    Number(schedulerRows[0]?.count ?? 0) > 0,
      jobs_completed_today: Number(jobRows[0]?.jobs_today ?? 0),
      server_uptime_seconds: Math.floor(process.uptime()),
    };
  }

  async getActivityFeed(limit = 20): Promise<Record<string, any>[]> {
    try {
      const rows = await this.dataSource.query(`
        SELECT
          id, module, entity_type, entity_id, action, title, description,
          performed_by_name, performed_by_role, severity, source, created_at
        FROM activity_logs
        ORDER BY created_at DESC
        LIMIT $1
      `, [Math.min(limit, 50)]);

      return rows.map((r: any) => ({
        id:          r.id,
        module:      r.module,
        entity_type: r.entity_type,
        entity_id:   r.entity_id,
        action:      r.action,
        title:       r.title,
        description: r.description,
        actor:       r.performed_by_name,
        role:        r.performed_by_role,
        severity:    r.severity,
        source:      r.source,
        timestamp:   r.created_at,
      }));
    } catch { return []; }
  }
}

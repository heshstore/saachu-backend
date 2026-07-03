import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { QueueStatus } from '../entities/enums';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { getActiveLimits } from '../shared/number-limits';
import {
  fetchAuthoritativeMetrics,
  rollupCumulativeFromStatusRows,
  startOfToday,
} from './metrics.definitions';

type StatusRow = { status: string; count: string };

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private repo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappNumber)
    private numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(WhatsappMessageQueue)
    private queueRepo: Repository<WhatsappMessageQueue>,
    @InjectDataSource()
    private ds: DataSource,
    private readonly marketingWa: MarketingWhatsAppService,
  ) {}

  async getCampaignStats(campaignId: string): Promise<Record<string, number>> {
    const stats = await fetchAuthoritativeMetrics(this.ds, new Date(0), {
      campaignId,
    });

    this.logger.log(
      `[MKT_CAMPAIGN_STATS_QUERY] campaign_id=${campaignId} ` +
        `sent=${stats.sent} read=${stats.read} delivered=${stats.delivered} ` +
        `failed=${stats.failed} skipped=${stats.skipped} not_on_whatsapp=${stats.not_on_whatsapp} total=${stats.total}`,
    );
    return { ...stats };
  }

  async getDashboardStats(): Promise<Record<string, number>> {
    return { ...(await fetchAuthoritativeMetrics(this.ds, new Date(0))) };
  }

  async getNumberStats(numberId: string): Promise<Record<string, number>> {
    return {
      ...(await fetchAuthoritativeMetrics(this.ds, new Date(0), { numberId })),
    };
  }

  async findLogs(filters: {
    status?: string;
    phone?: string;
    campaignId?: string;
    limit?: number;
  }): Promise<WhatsappMessageLog[]> {
    const limit = filters.limit ?? 100;
    const qb = this.repo
      .createQueryBuilder('l')
      .orderBy('l.sent_at', 'DESC')
      .limit(limit);
    if (filters.status)
      qb.andWhere('l.status = :status', { status: filters.status });
    if (filters.phone)
      qb.andWhere('l.customer_phone = :phone', { phone: filters.phone });
    if (filters.campaignId)
      qb.andWhere('l.campaign_id = :campaignId', {
        campaignId: filters.campaignId,
      });
    return qb.getMany();
  }

  async getEngineDashboardStats(): Promise<Record<string, number | string>> {
    const todayMidnight = startOfToday();
    this.logger.log(
      `[MKT_DASHBOARD] endpoint=engine/dashboard starting stats fetch`,
    );

    let active_numbers = 0;
    let metrics = {
      sent: 0,
      delivered: 0,
      read: 0,
      replied: 0,
      leads: 0,
      failed: 0,
      skipped: 0,
      not_on_whatsapp: 0,
      queue_pending: 0,
    };

    try {
      [active_numbers, metrics] = await Promise.all([
        this.numberRepo.count({ where: { is_active: true } }),
        fetchAuthoritativeMetrics(this.ds, todayMidnight),
      ]);
    } catch (err: any) {
      this.logger.error(
        `[MKT_DASHBOARD] endpoint=engine/dashboard fail=stats_query reason=${err?.message}`,
      );
    }

    this.logger.log(
      `[MKT_DASHBOARD] endpoint=engine/dashboard success=true ` +
        `active_numbers=${active_numbers} queue_pending=${metrics.queue_pending} sent_today=${metrics.sent} ` +
        `delivered_today=${metrics.delivered} read_today=${metrics.read} replied_today=${metrics.replied} ` +
        `not_on_whatsapp_today=${metrics.not_on_whatsapp} failed_today=${metrics.failed} crm_leads_today=${metrics.leads}`,
    );

    return {
      active_numbers,
      queue_pending: metrics.queue_pending,
      sent_today: metrics.sent,
      delivered_today: metrics.delivered,
      read_today: metrics.read,
      replied_today: metrics.replied,
      crm_leads_today: metrics.leads,
      not_on_whatsapp_today: metrics.not_on_whatsapp,
      failed_today: metrics.failed,
    };
  }

  // Per-template reply/read performance from last 30 days
  async getTemplatePerformance(): Promise<
    {
      template_id: string;
      template_name: string;
      performance_weight: number;
      sent: number;
      read: number;
      replied: number;
      read_rate_pct: number;
      reply_rate_pct: number;
    }[]
  > {
    type TRow = {
      template_id: string;
      template_name: string;
      performance_weight: string;
      sent: string;
      read: string;
      replied: string;
    };

    const rows: TRow[] = await this.ds.query(`
      SELECT
        t.id                                                                   AS template_id,
        t.template_name,
        t.performance_weight,
        COUNT(l.id)                                                            AS sent,
        COUNT(l.id) FILTER (WHERE l.status IN ('read','replied'))              AS read,
        COUNT(l.id) FILTER (WHERE l.status = 'replied')                        AS replied
      FROM marketing_templates t
      LEFT JOIN whatsapp_message_queue q ON q.template_id = t.id
      LEFT JOIN whatsapp_message_logs  l ON l.queue_id   = q.id
        AND l.sent_at >= NOW() - INTERVAL '30 days'
      GROUP BY t.id, t.template_name, t.performance_weight
      ORDER BY replied DESC, read DESC
    `);

    return rows.map((r) => {
      const sent = parseInt(r.sent, 10);
      const read = parseInt(r.read, 10);
      const replied = parseInt(r.replied, 10);
      return {
        template_id: r.template_id,
        template_name: r.template_name,
        performance_weight: parseFloat(r.performance_weight),
        sent,
        read,
        replied,
        read_rate_pct: sent > 0 ? Math.round((read / sent) * 100) : 0,
        reply_rate_pct: sent > 0 ? Math.round((replied / sent) * 100) : 0,
      };
    });
  }

  // Daily operational report — everything needed for the morning review in one call
  async getDailyReport(): Promise<{
    date: string;
    delivery_funnel: Record<string, number>;
    audience: {
      total: number;
      eligible: number;
      in_cooldown: number;
      opted_out: number;
    };
    number_health: {
      id: string;
      phone: string;
      name: string;
      daily_sent: number;
      daily_cap: number;
      risk_score: number;
      is_active: boolean;
      waState: string;
    }[];
    top_templates: {
      template_name: string;
      replied: number;
      reply_rate_pct: number;
    }[];
    crm_leads_today: number;
    risk_alerts: number;
    env: {
      pilot_mode: boolean;
      test_only: boolean;
      max_daily_audience: string;
    };
  }> {
    const todayMidnight = startOfToday();

    const [metrics, audienceStats, numbers, templatePerf] = await Promise.all([
      fetchAuthoritativeMetrics(this.ds, todayMidnight),
      this.ds.query(`
        SELECT
          COUNT(*)                                                                       AS total,
          COUNT(*) FILTER (WHERE opt_out = false AND is_whatsapp_valid = true AND (cooldown_until IS NULL OR cooldown_until <= NOW())) AS eligible,
          COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW())  AS in_cooldown,
          COUNT(*) FILTER (WHERE opt_out = true)                                         AS opted_out
        FROM marketing_audience
      `),
      this.numberRepo.find({ order: { daily_sent: 'DESC' } }),
      this.getTemplatePerformance(),
    ]);

    const crm_leads_today = metrics.leads;

    const ar = audienceStats[0] ?? {};
    const riskAlerts = numbers.filter((n) => Number(n.risk_score) >= 60).length;

    return {
      date: todayMidnight.toISOString().slice(0, 10),
      delivery_funnel: {
        sent: metrics.sent,
        delivered: metrics.delivered,
        read: metrics.read,
        replied: metrics.replied,
        failed: metrics.failed,
        skipped: metrics.skipped,
        not_on_whatsapp: metrics.not_on_whatsapp,
      },
      audience: {
        total: parseInt(ar.total ?? '0', 10),
        eligible: parseInt(ar.eligible ?? '0', 10),
        in_cooldown: parseInt(ar.in_cooldown ?? '0', 10),
        opted_out: parseInt(ar.opted_out ?? '0', 10),
      },
      number_health: numbers.map((n) => ({
        id: n.id,
        phone: n.phone,
        name: n.name,
        daily_sent: n.daily_sent,
        daily_cap: getActiveLimits(n.warmup_level).daily,
        risk_score: Number(n.risk_score),
        is_active: n.is_active,
        waState: this.marketingWa.getNumberWaStatus(n.id).waState,
      })),
      top_templates: templatePerf
        .filter((t) => t.sent > 0)
        .slice(0, 5)
        .map((t) => ({
          template_name: t.template_name,
          replied: t.replied,
          reply_rate_pct: t.reply_rate_pct,
        })),
      crm_leads_today,
      risk_alerts: riskAlerts,
      env: {
        pilot_mode: process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
        test_only: process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true',
        max_daily_audience:
          process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE ?? 'unlimited',
      },
    };
  }

  // Conversion funnel: message → reply → CRM lead → telecaller follow-up
  // days defaults to 7; pass 30 for a monthly view
  async getConversionFunnel(days = 7): Promise<{
    since: string;
    unique_messaged: number;
    messages_sent: number;
    replied: number;
    crm_leads: number;
    telecaller_followed_up: number;
    reply_rate_pct: number;
    lead_rate_pct: number;
    followup_rate_pct: number;
  }> {
    const since = new Date(Date.now() - days * 86_400_000);

    type FunnelRow = {
      unique_messaged: string;
      messages_sent: string;
      replied: string;
    };

    const [funnelRows, replyCountRows, leadRows] = await Promise.all([
      this.ds.query<FunnelRow[]>(
        `SELECT
           COUNT(DISTINCT l.customer_phone) AS unique_messaged,
           COUNT(l.id)                      AS messages_sent,
           0                                AS replied
         FROM whatsapp_message_logs l
         WHERE l.sent_at >= $1
           AND l.status IN ('sent','delivered','read','replied')`,
        [since],
      ),
      this.ds.query<{ cnt: string }[]>(
        `SELECT COUNT(*)::int AS cnt FROM whatsapp_replies r WHERE r.received_at >= $1`,
        [since],
      ),
      this.ds.query<{ crm_leads: string; followed_up: string }[]>(
        `SELECT
           COUNT(DISTINCT ld.id)                                                                              AS crm_leads,
           COUNT(DISTINCT ld.id) FILTER (WHERE ld.status NOT IN ('new', 'unassigned', 'junk'))                AS followed_up
         FROM leads ld
         WHERE ld.source = 'WHATSAPP'
           AND ld.created_at >= $1`,
        [since],
      ),
    ]);

    const f = funnelRows[0];
    const l = leadRows[0];

    const uniqueMessaged = parseInt(f?.unique_messaged ?? '0', 10);
    const messagesSent = parseInt(f?.messages_sent ?? '0', 10);
    const replied = parseInt(replyCountRows[0]?.cnt ?? '0', 10);
    const crmLeads = parseInt(l?.crm_leads ?? '0', 10);
    const followedUp = parseInt(l?.followed_up ?? '0', 10);

    return {
      since: since.toISOString().slice(0, 10),
      unique_messaged: uniqueMessaged,
      messages_sent: messagesSent,
      replied,
      crm_leads: crmLeads,
      telecaller_followed_up: followedUp,
      reply_rate_pct:
        uniqueMessaged > 0 ? Math.round((replied / uniqueMessaged) * 100) : 0,
      lead_rate_pct:
        uniqueMessaged > 0 ? Math.round((crmLeads / uniqueMessaged) * 100) : 0,
      followup_rate_pct:
        crmLeads > 0 ? Math.round((followedUp / crmLeads) * 100) : 0,
    };
  }

  async getHistoricalPromotionAnalytics(
    days = 90,
  ): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000);

    const [
      previousCampaigns,
      historicalQueue,
      productRotationHistory,
      validationHistory,
      dailyTrends,
      weeklyTrends,
      monthlyTrends,
      warmupHistory,
      promotionHistory,
    ] = await Promise.all([
      this.ds
        .query(
          `
        SELECT
          c.id, c.promo_id, c.campaign_name, c.status, c.test_mode,
          c.telecaller_number_id, n.phone AS telecaller_phone, c.created_at,
          COUNT(q.id)::int AS queue_total,
          COUNT(q.id) FILTER (WHERE q.status = 'pending')::int AS queue_pending
        FROM marketing_campaigns c
        LEFT JOIN whatsapp_numbers n ON n.id = c.telecaller_number_id
        LEFT JOIN whatsapp_message_queue q ON q.campaign_id = c.id
        WHERE c.is_promotion = true AND c.created_at < $1
        GROUP BY c.id, n.phone
        ORDER BY c.created_at DESC
        LIMIT 100
      `,
          [startOfToday()],
        )
        .catch(() => []),
      this.ds
        .query(
          `
        SELECT
          q.status, q.error_message AS skip_reason,
          n.phone AS telecaller_phone, n.name AS telecaller_name,
          COUNT(*)::int AS count
        FROM whatsapp_message_queue q
        LEFT JOIN whatsapp_numbers n ON n.id = q.number_id
        WHERE q.created_at >= $1
        GROUP BY q.status, q.error_message, n.phone, n.name
        ORDER BY n.phone, q.status
      `,
          [since],
        )
        .catch(() => []),
      this.ds
        .query(
          `
        SELECT
          r.sku, s.item_name AS product_name, r.campaign_id, c.promo_id,
          n.phone AS telecaller_phone,
          COUNT(DISTINCT r.id)::int AS times_used,
          MAX(r.sent_at) AS last_sent_at
        FROM promotion_product_rotation r
        LEFT JOIN shopify_catalog_items s ON s.id = r.product_id
        LEFT JOIN marketing_campaigns c ON c.id = r.campaign_id
        LEFT JOIN whatsapp_numbers n ON n.id = r.telecaller_number_id
        WHERE r.sent_at >= $1
        GROUP BY r.sku, s.item_name, r.campaign_id, c.promo_id, n.phone
        ORDER BY last_sent_at DESC
        LIMIT 100
      `,
          [since],
        )
        .catch(() => []),
      this.ds
        .query(
          `
        SELECT
          c.id, c.promo_id, c.campaign_name, c.status, c.created_at,
          COUNT(q.id)::int AS queue_total,
          COUNT(q.id) FILTER (WHERE q.status = 'sent')::int AS sent,
          COUNT(q.id) FILTER (WHERE q.status = 'failed')::int AS failed,
          COUNT(q.id) FILTER (WHERE q.status = 'skipped')::int AS skipped
        FROM marketing_campaigns c
        LEFT JOIN whatsapp_message_queue q ON q.campaign_id = c.id
        WHERE (c.promo_id LIKE 'VALIDATION-%' OR c.campaign_name LIKE 'VALIDATION-%')
          AND c.created_at >= $1
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT 100
      `,
          [since],
        )
        .catch(() => []),
      this._trendRows('day', since),
      this._trendRows('week', since),
      this._trendRows('month', since),
      this.ds
        .query(
          `
        SELECT
          al.created_at,
          al.number_id,
          n.phone AS telecaller_phone,
          n.name AS telecaller_name,
          al.event,
          al.reason,
          al.metadata
        FROM engine_audit_logs al
        LEFT JOIN whatsapp_numbers n ON n.id = al.number_id
        WHERE al.event IN ('WARMUP_RESET', 'WARMUP_PROMOTED')
          AND al.created_at >= $1
        ORDER BY al.created_at DESC
        LIMIT 200
      `,
          [since],
        )
        .catch(() => []),
      this.ds
        .query(
          `
        SELECT
          al.created_at,
          al.number_id,
          n.phone AS telecaller_phone,
          al.event,
          al.reason,
          al.metadata
        FROM engine_audit_logs al
        LEFT JOIN whatsapp_numbers n ON n.id = al.number_id
        WHERE al.event IN ('LOW_DELIVERY_WARNING', 'LOW_READ_WARNING', 'LOW_REPLY_WARNING')
          AND al.created_at >= $1
        ORDER BY al.created_at DESC
        LIMIT 200
      `,
          [since],
        )
        .catch(() => []),
    ]);

    return {
      since: since.toISOString(),
      previous_campaigns: previousCampaigns,
      campaign_history: previousCampaigns,
      historical_queue: historicalQueue,
      product_rotation_history: productRotationHistory,
      validation_history: validationHistory,
      daily_trends: dailyTrends,
      weekly_trends: weeklyTrends,
      monthly_trends: monthlyTrends,
      warmup_history: warmupHistory,
      promotion_history: promotionHistory,
    };
  }

  private async _trendRows(
    bucket: 'day' | 'week' | 'month',
    since: Date,
  ): Promise<Record<string, unknown>[]> {
    return this.ds
      .query(
        `
      SELECT
        DATE_TRUNC('${bucket}', l.sent_at AT TIME ZONE 'Asia/Kolkata')::date AS period,
        COUNT(*) FILTER (WHERE l.status IN ('sent','delivered','read','replied'))::int AS sent,
        COUNT(*) FILTER (WHERE l.status IN ('delivered','read','replied'))::int AS delivered,
        COUNT(*) FILTER (WHERE l.status IN ('read','replied'))::int AS read,
        COUNT(*) FILTER (WHERE l.status = 'failed')::int AS failed,
        COUNT(r.id)::int AS replies
      FROM whatsapp_message_logs l
      LEFT JOIN whatsapp_replies r ON r.customer_phone = l.customer_phone
        AND r.number_id IS NOT DISTINCT FROM l.number_id
        AND r.received_at >= l.sent_at
      WHERE l.sent_at >= $1
      GROUP BY 1
      ORDER BY 1 ASC
    `,
        [since],
      )
      .catch(() => []);
  }

  private _buildStats(rows: StatusRow[]): Record<string, number> {
    const raw: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      raw[r.status] = (raw[r.status] ?? 0) + n;
      total += n;
    }

    const rolled = rollupCumulativeFromStatusRows(raw);

    this.logger.log(
      `[CAMPAIGN_AUDIT] _buildStats cumulative rollup: ` +
        `raw={sent:${raw['sent'] ?? 0},delivered:${raw['delivered'] ?? 0},read:${raw['read'] ?? 0},replied:${raw['replied'] ?? 0}} ` +
        `cumulative={sent:${rolled.sent},delivered:${rolled.delivered},read:${rolled.read},replied:${rolled.replied}} ` +
        `failed:${rolled.failed} skipped:${rolled.skipped} total:${total}`,
    );

    return {
      ...rolled,
      not_on_whatsapp: 0,
      total,
    };
  }
}

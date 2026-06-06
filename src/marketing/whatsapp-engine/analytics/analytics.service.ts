import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { QueueStatus } from '../entities/enums';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { getActiveLimits } from '../shared/number-limits';

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
    // Three-tier resolution for historical data where campaign_id was not persisted on queue rows:
    // 1. Log row has campaign_id directly (current path)
    // 2. Log row's queue_id points to a queue item with campaign_id set
    // 3. (Historical fallback) queue item has no campaign_id but template matches this campaign.
    //    Scoped to q.campaign_id IS NULL AND q.created_at >= campaign.created_at.
    //    The date guard prevents pre-campaign autonomous-engine sends (which use null campaign_id
    //    for templates not linked to a running campaign) from being incorrectly attributed to this
    //    campaign just because they share the same template_id.
    const rows = await this.ds.query<StatusRow[]>(`
      SELECT l.status, COUNT(*)::text AS count
      FROM whatsapp_message_logs l
      WHERE l.campaign_id = $1
         OR l.queue_id IN (
           SELECT q.id
           FROM whatsapp_message_queue q
           WHERE q.campaign_id = $1
              OR (
                q.campaign_id IS NULL
                AND q.created_at >= (SELECT c2.created_at FROM marketing_campaigns c2 WHERE c2.id = $1)
                AND q.template_id IN (
                  SELECT c.template_id
                  FROM marketing_campaigns c
                  WHERE c.id = $1 AND c.template_id IS NOT NULL
                )
              )
         )
      GROUP BY l.status
    `, [campaignId]);

    const stats = this._buildStats(rows);
    this.logger.log(
      `[MKT_CAMPAIGN_STATS_QUERY] campaign_id=${campaignId} ` +
      `sent=${stats.sent} read=${stats.read} delivered=${stats.delivered} ` +
      `failed=${stats.failed} skipped=${stats.skipped ?? 0} total=${stats.total}`,
    );
    return stats;
  }

  async getDashboardStats(): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status')
      .getRawMany<StatusRow>();
    return this._buildStats(rows);
  }

  async getNumberStats(numberId: string): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.number_id = :numberId', { numberId })
      .groupBy('l.status')
      .getRawMany<StatusRow>();
    return this._buildStats(rows);
  }

  async findLogs(filters: {
    status?: string;
    phone?: string;
    campaignId?: string;
    limit?: number;
  }): Promise<WhatsappMessageLog[]> {
    const limit = filters.limit ?? 100;
    const qb = this.repo.createQueryBuilder('l').orderBy('l.sent_at', 'DESC').limit(limit);
    if (filters.status)     qb.andWhere('l.status = :status',        { status: filters.status });
    if (filters.phone)      qb.andWhere('l.customer_phone = :phone', { phone: filters.phone });
    if (filters.campaignId) qb.andWhere('l.campaign_id = :campaignId', { campaignId: filters.campaignId });
    return qb.getMany();
  }

  async getEngineDashboardStats(): Promise<Record<string, number | string>> {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    this.logger.log(`[MKT_DASHBOARD] endpoint=engine/dashboard starting stats fetch`);

    let active_numbers = 0, queue_pending = 0, sent_today = 0,
        delivered_today = 0, read_today = 0, replied_today = 0, crm_leads_today = 0;

    try {
      // Use sent_at for ALL date filters — it is always set on log rows and avoids
      // the delivered_at / read_at columns that may be absent in older DB schemas.
      // [CAMPAIGN_AUDIT] Use cumulative IN-list counts so that a message at READ
      // is also counted as delivered and sent. This matches the _buildStats rollup
      // and prevents sent_today < read_today on the dashboard.
      [
        active_numbers,
        queue_pending,
        sent_today,
        delivered_today,
        read_today,
        replied_today,
      ] = await Promise.all([
        this.numberRepo.count({ where: { is_active: true } }),
        this.queueRepo.count({ where: { status: QueueStatus.PENDING } }),
        this.repo.createQueryBuilder('l')
          .where('l.status IN (:...ss)', { ss: [QueueStatus.SENT, QueueStatus.DELIVERED, QueueStatus.READ, QueueStatus.REPLIED] })
          .andWhere('l.sent_at >= :mid', { mid: todayMidnight }).getCount(),
        this.repo.createQueryBuilder('l')
          .where('l.status IN (:...ss)', { ss: [QueueStatus.DELIVERED, QueueStatus.READ, QueueStatus.REPLIED] })
          .andWhere('l.sent_at >= :mid', { mid: todayMidnight }).getCount(),
        this.repo.createQueryBuilder('l')
          .where('l.status IN (:...ss)', { ss: [QueueStatus.READ, QueueStatus.REPLIED] })
          .andWhere('l.sent_at >= :mid', { mid: todayMidnight }).getCount(),
        this.repo.createQueryBuilder('l')
          .where('l.status = :s', { s: QueueStatus.REPLIED })
          .andWhere('l.sent_at >= :mid', { mid: todayMidnight }).getCount(),
      ]);
    } catch (err: any) {
      this.logger.error(`[MKT_DASHBOARD] endpoint=engine/dashboard fail=stats_query reason=${err?.message}`);
    }

    try {
      const rows: { count: string }[] = await this.ds.query(
        // Match all WHATSAPP-source leads created today.
        // Previously used context LIKE '%Marketing Engine%' which never matched the actual
        // stored context value ('WHATSAPP – Inbound Message' from LeadContext.WHATSAPP_INBOUND).
        `SELECT COUNT(*) AS count FROM leads WHERE source = $1 AND created_at >= $2`,
        ['WHATSAPP', todayMidnight],
      );
      crm_leads_today = parseInt(rows[0]?.count ?? '0', 10);
    } catch { crm_leads_today = 0; }

    this.logger.log(
      `[MKT_DASHBOARD] endpoint=engine/dashboard success=true ` +
      `active_numbers=${active_numbers} queue_pending=${queue_pending} sent_today=${sent_today} ` +
      `delivered_today=${delivered_today} read_today=${read_today} replied_today=${replied_today} ` +
      `crm_leads_today=${crm_leads_today}`,
    );

    return { active_numbers, queue_pending, sent_today, delivered_today, read_today, replied_today, crm_leads_today };
  }

  // Per-template reply/read performance from last 30 days
  async getTemplatePerformance(): Promise<{
    template_id: string;
    template_name: string;
    performance_weight: number;
    sent: number;
    read: number;
    replied: number;
    read_rate_pct: number;
    reply_rate_pct: number;
  }[]> {
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
      const sent    = parseInt(r.sent, 10);
      const read    = parseInt(r.read, 10);
      const replied = parseInt(r.replied, 10);
      return {
        template_id: r.template_id,
        template_name: r.template_name,
        performance_weight: parseFloat(r.performance_weight),
        sent,
        read,
        replied,
        read_rate_pct:  sent > 0 ? Math.round((read    / sent) * 100) : 0,
        reply_rate_pct: sent > 0 ? Math.round((replied / sent) * 100) : 0,
      };
    });
  }

  // Daily operational report — everything needed for the morning review in one call
  async getDailyReport(): Promise<{
    date: string;
    delivery_funnel: Record<string, number>;
    audience: { total: number; eligible: number; in_cooldown: number; opted_out: number };
    number_health: { id: string; phone: string; name: string; daily_sent: number; daily_limit: number; risk_score: number; is_active: boolean; waState: string }[];
    top_templates: { template_name: string; replied: number; reply_rate_pct: number }[];
    crm_leads_today: number;
    risk_alerts: number;
    env: { pilot_mode: boolean; test_only: boolean; max_daily_audience: string };
  }> {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const [funnelRows, audienceStats, numbers, templatePerf] = await Promise.all([
      this.repo
        .createQueryBuilder('l')
        .select('l.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('l.sent_at >= :since', { since: todayMidnight })
        .groupBy('l.status')
        .getRawMany<StatusRow>(),
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

    const funnel: Record<string, number> = {};
    for (const r of funnelRows) funnel[r.status] = parseInt(r.count, 10);

    let crm_leads_today = 0;
    try {
      const cr: { count: string }[] = await this.ds.query(
        `SELECT COUNT(*) AS count FROM leads WHERE source = 'WHATSAPP' AND context LIKE '%Marketing Engine%' AND created_at >= $1`,
        [todayMidnight],
      );
      crm_leads_today = parseInt(cr[0]?.count ?? '0', 10);
    } catch { crm_leads_today = 0; }

    const ar = audienceStats[0] ?? {};
    const riskAlerts = numbers.filter((n) => Number(n.risk_score) >= 60).length;

    return {
      date: todayMidnight.toISOString().slice(0, 10),
      delivery_funnel: {
        sent: funnel['sent'] ?? 0,
        delivered: funnel['delivered'] ?? 0,
        read: funnel['read'] ?? 0,
        replied: funnel['replied'] ?? 0,
        failed: funnel['failed'] ?? 0,
        skipped: funnel['skipped'] ?? 0,
      },
      audience: {
        total:       parseInt(ar.total       ?? '0', 10),
        eligible:    parseInt(ar.eligible    ?? '0', 10),
        in_cooldown: parseInt(ar.in_cooldown ?? '0', 10),
        opted_out:   parseInt(ar.opted_out   ?? '0', 10),
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
        .map((t) => ({ template_name: t.template_name, replied: t.replied, reply_rate_pct: t.reply_rate_pct })),
      crm_leads_today,
      risk_alerts: riskAlerts,
      env: {
        pilot_mode:         process.env.WHATSAPP_ENGINE_PILOT_MODE  === 'true',
        test_only:          process.env.WHATSAPP_ENGINE_TEST_ONLY   === 'true',
        max_daily_audience: process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE ?? 'unlimited',
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

    const [funnelRows, leadRows] = await Promise.all([
      this.ds.query<FunnelRow[]>(
        `SELECT
           COUNT(DISTINCT l.customer_phone) AS unique_messaged,
           COUNT(l.id)                      AS messages_sent,
           COUNT(l.id) FILTER (WHERE l.reply_received = true) AS replied
         FROM whatsapp_message_logs l
         WHERE l.sent_at >= $1`,
        [since],
      ),
      this.ds.query<{ crm_leads: string; followed_up: string }[]>(
        `SELECT
           COUNT(DISTINCT ld.id)                                                                              AS crm_leads,
           COUNT(DISTINCT ld.id) FILTER (WHERE ld.status NOT IN ('new', 'unassigned', 'junk'))                AS followed_up
         FROM leads ld
         WHERE ld.source = 'WHATSAPP'
           AND ld.context LIKE '%Marketing Engine%'
           AND ld.created_at >= $1`,
        [since],
      ),
    ]);

    const f = funnelRows[0];
    const l = leadRows[0];

    const uniqueMessaged = parseInt(f?.unique_messaged ?? '0', 10);
    const messagesSent   = parseInt(f?.messages_sent   ?? '0', 10);
    const replied        = parseInt(f?.replied         ?? '0', 10);
    const crmLeads       = parseInt(l?.crm_leads       ?? '0', 10);
    const followedUp     = parseInt(l?.followed_up     ?? '0', 10);

    return {
      since: since.toISOString().slice(0, 10),
      unique_messaged:      uniqueMessaged,
      messages_sent:        messagesSent,
      replied,
      crm_leads:            crmLeads,
      telecaller_followed_up: followedUp,
      reply_rate_pct:    uniqueMessaged > 0 ? Math.round((replied        / uniqueMessaged) * 100) : 0,
      lead_rate_pct:     uniqueMessaged > 0 ? Math.round((crmLeads       / uniqueMessaged) * 100) : 0,
      followup_rate_pct: crmLeads      > 0 ? Math.round((followedUp     / crmLeads)       * 100) : 0,
    };
  }

  private _buildStats(rows: StatusRow[]): Record<string, number> {
    // Count raw exclusive per-status first
    const raw: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      raw[r.status] = (raw[r.status] ?? 0) + n;
      total += n;
    }

    // [CAMPAIGN_AUDIT] Cumulative funnel: a message at READ was also DELIVERED and SENT.
    // Status upgrades (SENT → DELIVERED → READ) mean the DB row holds only the latest
    // status. Without this rollup, sent_count falls as messages progress, causing read > sent.
    const replied   = raw['replied']   ?? 0;
    const read      = (raw['read']     ?? 0) + replied;
    const delivered = (raw['delivered'] ?? 0) + read;
    const sent      = (raw['sent']     ?? 0) + delivered;

    this.logger.log(
      `[CAMPAIGN_AUDIT] _buildStats cumulative rollup: ` +
      `raw={sent:${raw['sent'] ?? 0},delivered:${raw['delivered'] ?? 0},read:${raw['read'] ?? 0},replied:${replied}} ` +
      `cumulative={sent:${sent},delivered:${delivered},read:${read},replied:${replied}} ` +
      `failed:${raw['failed'] ?? 0} skipped:${raw['skipped'] ?? 0} total:${total}`,
    );

    return {
      sent,
      delivered,
      read,
      replied,
      failed:  raw['failed']  ?? 0,
      skipped: raw['skipped'] ?? 0,
      total,
    };
  }
}

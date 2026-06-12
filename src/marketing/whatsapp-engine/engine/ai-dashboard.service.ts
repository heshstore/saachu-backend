import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineSettingsService } from './engine-settings.service';
import { getReleaseAllowance, getWarmupLabel, getMatureDailyCapacity } from '../shared/number-limits';
import { fetchAuthoritativeMetrics } from '../analytics/metrics.definitions';
import { getIstDayBounds } from '../shared/ist-time';
import { NumberConnectionState } from '../shared/number-state';
import { WarmupProgressionService } from './warmup-progression.service';
import { detectWarnings } from '../shared/warmup-health';

@Injectable()
export class AiDashboardService {
  private readonly logger = new Logger(AiDashboardService.name);

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    private readonly whatsAppService: MarketingWhatsAppService,
    private readonly engineSettings: EngineSettingsService,
    private readonly warmupProgression: WarmupProgressionService,
  ) {}

  async getDashboard() {
    const { start: today } = getIstDayBounds();
    const todayIso = today.toISOString();

    const [
      engineStatus,
      todayActivity,
      todayActivityByTelecaller,
      campaigns,
      telecallerPerformance,
      todayQueue,
      numberUtilization,
      todayQueueByTelecaller,
      audienceStatus,
    ] = await Promise.all([
      this._getEngineStatus(todayIso),
      this._getTodayActivity(todayIso),
      this._getTodayActivityByTelecaller(todayIso),
      this._getAiCampaigns(todayIso),
      this._getTelecallerPerformance(todayIso),
      this._getTodayQueueSummary(todayIso),
      this._getNumberUtilization(todayIso),
      this._getTodayQueueByTelecaller(todayIso),
      this._getAudienceStatus(),
    ]);

    const isInconsistent = todayActivity.queue_items > 0 && todayActivity.campaigns_created === 0;
    const warnings = this._computeWarnings(todayActivity, engineStatus, todayQueue);

    return {
      engine_status:             engineStatus,
      today_activity:            todayActivity,
      today_activity_by_telecaller: todayActivityByTelecaller,
      campaigns,
      telecaller_performance:    telecallerPerformance,
      live_queue:                todayQueue,
      today_queue:               todayQueue,
      number_utilization:        numberUtilization,
      today_queue_by_telecaller: todayQueueByTelecaller,
      audience_status: {
        ...audienceStatus,
        queue_built_today: todayActivity.queue_items,
      },
      is_inconsistent:           isInconsistent,
      warnings,
      as_of:                     new Date().toISOString(),
    };
  }

  // ── Section A: Engine Status ───────────────────────────────────────────────

  private async _getEngineStatus(todayIso: string) {
    const autoAiMode      = await this.engineSettings.getAutoAiMode().catch(() => false);
    const allNumbers      = await this.numberRepo.find();
    const connectedNumbers = allNumbers.filter(n => this.whatsAppService.getNumberState(n.id) === NumberConnectionState.CONNECTED);
    const waConnected     = connectedNumbers.length > 0;

    const lastRunRows = await this.ds.query<{ created_at: string; metadata: unknown }[]>(
      `SELECT created_at, metadata FROM engine_audit_logs
       WHERE event = 'QUEUE_CREATED'
       ORDER BY created_at DESC LIMIT 1`,
    ).catch(() => []);
    const lastAiRun = lastRunRows[0]?.created_at ?? null;

    const now = new Date();
    const { start: istTodayStart } = getIstDayBounds(now);
    let next = new Date(istTodayStart.getTime() + ((8 * 60 + 30) * 60 * 1000));
    if (now >= next) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);

    const validationRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM marketing_audience WHERE is_test_contact = true AND opt_out = false AND is_whatsapp_valid = true`,
    ).catch(() => [{ cnt: '0' }]);
    const validationContactsActive = parseInt(validationRows[0]?.cnt ?? '0', 10);

    // Engine ran today if: autonomous campaign created today OR queue rows built today
    const todayCampaignRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM marketing_campaigns
       WHERE is_promotion = true AND telecaller_number_id IS NOT NULL AND created_at >= $1`,
      [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    const todayQueueRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM whatsapp_message_queue WHERE created_at >= $1`,
      [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    const engineRanToday =
      parseInt(todayCampaignRows[0]?.cnt ?? '0', 10) > 0 ||
      parseInt(todayQueueRows[0]?.cnt    ?? '0', 10) > 0;

    const testOnlyMode = process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true';
    return {
      running:                    waConnected && (process.env.WHATSAPP_ENGINE_ENABLED !== 'false'),
      engine_enabled:             process.env.WHATSAPP_ENGINE_ENABLED !== 'false',
      pilot_mode:                 process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
      test_only_mode:             testOnlyMode,
      validation_mode_on:         testOnlyMode && validationContactsActive > 0,
      validation_contacts_active: validationContactsActive,
      autonomous_mode:            autoAiMode,
      last_ai_run:                lastAiRun,
      next_ai_run:                next.toISOString(),
      engine_ran_today:           engineRanToday,
      total_numbers:              allNumbers.length,
      connected_numbers:          connectedNumbers.length,
      numbers: allNumbers.map(n => {
        const waStatus = this.whatsAppService.getNumberWaStatus(n.id);
        return {
          id:              n.id,
          phone:           n.phone,
          name:            n.name,
          warmup_level:    n.warmup_level,
          daily_sent:      n.daily_sent,
          daily_limit:     n.daily_limit,
          is_active:       n.is_active,
          status:          n.status,
          connected:       waStatus.number_state === NumberConnectionState.CONNECTED,
          wa_state:        waStatus.waState,
          number_state:    waStatus.number_state,
          partial_session: waStatus.partial_session,
        };
      }),
    };
  }

  // ── Section B: Today's Activity ────────────────────────────────────────────
  // Counts ALL today's queue rows — including campaign_id=NULL (pre-campaign) ones.

  private async _getTodayActivity(todayIso: string) {
    const since = new Date(todayIso);
    const [rows, metrics] = await Promise.all([
      this.ds.query<{
        campaigns_today:   string;
        queue_items_today: string;
      }[]>(`
        SELECT
          (SELECT COUNT(*) FROM marketing_campaigns
           WHERE is_promotion = true AND created_at >= $1) AS campaigns_today,
          (SELECT COUNT(*) FROM whatsapp_message_queue
           WHERE created_at >= $1) AS queue_items_today
      `, [todayIso]).catch(() => []),
      fetchAuthoritativeMetrics(this.ds, since),
    ]);

    const r = rows[0] ?? {};
    const queueTotal   = parseInt(r.queue_items_today ?? '0', 10);
    const campaignsVal = parseInt(r.campaigns_today   ?? '0', 10);

    return {
      campaigns_created: campaignsVal,
      campaigns_display: queueTotal > 0 && campaignsVal === 0 ? '—' : campaignsVal,
      queue_items:       queueTotal,
      messages_sent:     metrics.sent,
      replies:           metrics.replied,
      leads_created:     metrics.leads,
      failures:          metrics.failed,
      skipped:           metrics.skipped,
    };
  }

  // ── Database summary counts (Customer DB + Promotional DB) ─────────────────

  private async _getDatabaseCounts() {
    const rows = await this.ds.query<{ customer_count: string; promotional_count: string }[]>(`
      SELECT
        (SELECT COUNT(*) FROM customer)           AS customer_count,
        (SELECT COUNT(*) FROM marketing_audience) AS promotional_count
    `).catch(() => [{ customer_count: '0', promotional_count: '0' }]);

    const r = rows[0] ?? { customer_count: '0', promotional_count: '0' };
    return {
      customer_db_count:    parseInt(r.customer_count    ?? '0', 10),
      promotional_db_count: parseInt(r.promotional_count ?? '0', 10),
    };
  }

  // ── Audience Status (Promotional DB + Eligible Today) ─────────────────────
  // Mirrors filterByQuality(30) criteria — same filters, COUNT only.

  private async _getAudienceStatus() {
    const rows = await this.ds.query<{
      promotional_count: string;
      customer_count:    string;
      eligible_count:    string;
    }[]>(`
      SELECT
        (SELECT COUNT(*) FROM marketing_audience)           AS promotional_count,
        (SELECT COUNT(*) FROM customer)                     AS customer_count,
        (SELECT COUNT(*) FROM marketing_audience a
          WHERE a.opt_out = false
            AND a.is_whatsapp_valid = true
            AND a.quality_score >= 30
            AND (a.cooldown_until IS NULL OR a.cooldown_until <= NOW())
            AND a.is_test_contact IS NOT TRUE
            AND (a.wa_registration_status IS NULL OR a.wa_registration_status != 'NOT_REGISTERED')
        )                                                    AS eligible_count
    `).catch(() => [{ promotional_count: '0', customer_count: '0', eligible_count: '0' }]);

    const r = rows[0] ?? { promotional_count: '0', customer_count: '0', eligible_count: '0' };
    return {
      promotional_db_count:    parseInt(r.promotional_count ?? '0', 10),
      customer_db_count:       parseInt(r.customer_count    ?? '0', 10),
      eligible_audience_today: parseInt(r.eligible_count    ?? '0', 10),
    };
  }

  async getQueueDetail() {
    const { start: today } = getIstDayBounds();
    return this._getCampaignQueueDetail(today.toISOString());
  }

  // ── Section B (per telecaller): Today's Activity ────────────────────────────
  // All metrics scoped to each whatsapp_numbers row (telecaller_number_id).

  private async _getTodayActivityByTelecaller(todayIso: string) {
    const since = new Date(todayIso);
    const numbers = await this.numberRepo.find({
      where: { is_active: true },
      order: { created_at: 'ASC' },
    });

    return Promise.all(numbers.map(async n => {
      const m = await fetchAuthoritativeMetrics(this.ds, since, { numberId: n.id });
      return {
        number_id:       n.id,
        phone:           n.phone,
        name:            n.name,
        messages_sent:   m.sent,
        replies:         m.replied,
        leads_created:   m.leads,
        not_on_whatsapp: m.not_on_whatsapp,
        failures:        m.failed,
        pending_queue:   m.queue_pending,
      };
    }));
  }

  // ── Section C: AI Campaigns — TODAY ONLY ───────────────────────────────────

  private async _getAiCampaigns(todayIso: string) {
    const rows = await this.ds.query<{
      id: string;
      promo_id: string | null;
      campaign_name: string;
      created_at: string | Date;
      status: string;
      is_promotion: boolean;
      test_mode: boolean;
      telecaller_number_id: string | null;
      telecaller_phone: string | null;
      total_queue: string;
      sent: string;
      failed: string;
      skipped: string;
      pending: string;
      is_today: boolean;
    }[]>(`
      SELECT
        c.id, c.promo_id, c.campaign_name, c.created_at, c.status,
        c.is_promotion, c.test_mode, c.telecaller_number_id,
        n.phone AS telecaller_phone,
        (c.created_at >= $1) AS is_today,
        COUNT(q.id)                                              AS total_queue,
        (SELECT COUNT(*)::int FROM whatsapp_message_logs l
          WHERE l.campaign_id = c.id
            AND l.status IN ('sent','delivered','read','replied')) AS sent,
        (SELECT COUNT(*)::int FROM whatsapp_message_logs l
          WHERE l.campaign_id = c.id AND l.status = 'failed')       AS failed,
        (SELECT COUNT(*)::int FROM whatsapp_message_logs l
          WHERE l.campaign_id = c.id AND l.status = 'skipped'
            AND l.message_body NOT ILIKE '%INVALID_WA_NUMBER%')   AS skipped,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')             AS pending
      FROM marketing_campaigns c
      LEFT JOIN whatsapp_message_queue q ON q.campaign_id = c.id
      LEFT JOIN whatsapp_numbers n ON n.id = c.telecaller_number_id
      WHERE c.is_promotion = true
        AND c.created_at >= $1
      GROUP BY c.id, c.promo_id, c.campaign_name, c.created_at, c.status,
               c.is_promotion, c.test_mode, c.telecaller_number_id, n.phone
      ORDER BY c.created_at DESC
      LIMIT 60
    `, [todayIso]).catch(() => []);

    // Replies per campaign (via message_logs join)
    const replyRows = await this.ds.query<{ campaign_id: string; cnt: string }[]>(`
      SELECT l.campaign_id, COUNT(*) AS cnt
      FROM whatsapp_replies r
      JOIN whatsapp_message_logs l ON l.customer_phone = r.customer_phone
        AND l.number_id = r.number_id
      WHERE l.campaign_id IS NOT NULL
        AND r.received_at >= $1
      GROUP BY l.campaign_id
    `, [todayIso]).catch(() => []);
    const replyMap = new Map<string, number>(
      replyRows.map(r => [r.campaign_id, parseInt(r.cnt, 10)] as [string, number]),
    );

    // Leads per campaign
    const leadRows = await this.ds.query<{ campaign_id: string; cnt: string }[]>(`
      SELECT l.campaign_id, COUNT(DISTINCT ld.id) AS cnt
      FROM leads ld
      JOIN whatsapp_message_logs l ON l.customer_phone = ld.phone
        AND l.campaign_id IS NOT NULL
        AND l.number_id = (SELECT c2.telecaller_number_id FROM marketing_campaigns c2 WHERE c2.id = l.campaign_id)
      WHERE ld.source = 'WHATSAPP'
        AND ld.created_at >= $1
      GROUP BY l.campaign_id
    `, [todayIso]).catch(() => []);
    const leadMap = new Map<string, number>(
      leadRows.map(r => [r.campaign_id, parseInt(r.cnt, 10)] as [string, number]),
    );

    // Products used per telecaller number today (from rotation table)
    const productRows = await this.ds.query<{
      telecaller_number_id: string;
      campaign_id: string | null;
      cnt: string;
    }[]>(`
      SELECT telecaller_number_id, campaign_id, COUNT(DISTINCT sku) AS cnt
      FROM promotion_product_rotation
      WHERE sent_at >= $1
      GROUP BY telecaller_number_id, campaign_id
    `, [todayIso]).catch(() => []);
    // Map: campaign_id → product count; fallback: telecaller_number_id → count
    const productByCampaign   = new Map<string, number>();
    const productByTelecaller = new Map<string, number>();
    for (const p of productRows) {
      if (p.campaign_id) productByCampaign.set(p.campaign_id, parseInt(p.cnt, 10));
      productByTelecaller.set(p.telecaller_number_id, parseInt(p.cnt, 10));
    }

    return rows.map(r => {
      const isToday = !!r.is_today;
      const promoId = r.promo_id ?? `PROMO-${new Date(r.created_at).toISOString().slice(0, 10).replace(/-/g, '')}-????`;
      const products = productByCampaign.get(r.id)
        ?? (isToday && r.telecaller_number_id ? productByTelecaller.get(r.telecaller_number_id) ?? 0 : 0);
      return {
        id:                   r.id,
        promo_id:             promoId,
        is_validation:        promoId.startsWith('VALIDATION-'),
        campaign_name:        r.campaign_name,
        created_at:           r.created_at,
        status:               r.status,
        test_mode:            r.test_mode,
        is_today:             isToday,
        telecaller_number_id: r.telecaller_number_id ?? null,
        telecaller_phone:     r.telecaller_phone ?? null,
        total_queue:          parseInt(r.total_queue ?? '0', 10),
        sent:                 parseInt(r.sent        ?? '0', 10),
        failed:               parseInt(r.failed      ?? '0', 10),
        skipped:              parseInt(r.skipped     ?? '0', 10),
        pending:              parseInt(r.pending     ?? '0', 10),
        replies:              replyMap.get(r.id) ?? 0,
        leads:                leadMap.get(r.id) ?? 0,
        products_used:        products,
      };
    });
  }

  // ── Section D: Campaign Queue Detail ──────────────────────────────────────
  // Per-customer rows for today — the operator can see exactly who got what.

  private async _getCampaignQueueDetail(todayIso: string) {
    const rows = await this.ds.query<{
      queue_id:            string;
      campaign_id:         string | null;
      promo_id:            string | null;
      customer_phone:      string;
      customer_name:       string | null;
      product_sku:         string | null;
      product_title:       string | null;
      queue_status:        string;
      skip_reason:         string | null;
      sent_at:             string | null;
      telecaller_phone:    string | null;
      read_at:             string | null;
      reply_received:      boolean | null;
      reply_message:       string | null;
      lead_created:        boolean | null;
      message_body:        string | null;
      ai_hook_type:        string | null;
      ai_cta_used:         string | null;
      product_image:       string | null;
      product_url:         string | null;
      generated_message:   string | null;
    }[]>(`
      SELECT
        q.id                                       AS queue_id,
        q.campaign_id,
        c.promo_id,
        q.customer_phone,
        q.message_payload->>'name'                 AS customer_name,
        q.message_payload->>'product_sku'          AS product_sku,
        COALESCE(
          s.item_name,
          (SELECT s2.item_name FROM shopify_catalog_items s2
           WHERE s2.sku = (q.message_payload->>'product_sku') LIMIT 1)
        )                                          AS product_title,
        q.status                                   AS queue_status,
        q.error_message                            AS skip_reason,
        q.sent_at,
        n.phone                                    AS telecaller_phone,
        l.read_at,
        l.reply_received,
        l.reply_message,
        (ld.id IS NOT NULL)                        AS lead_created,
        l.message_body,
        q.message_payload->'ai_metadata'->>'hookType'  AS ai_hook_type,
        q.message_payload->'ai_metadata'->>'ctaUsed'   AS ai_cta_used,
        q.message_payload->>'product_image'             AS product_image,
        q.message_payload->>'product_url'               AS product_url,
        q.message_payload->>'generated_message'         AS generated_message
      FROM whatsapp_message_queue q
      LEFT JOIN marketing_campaigns c     ON c.id = q.campaign_id
      LEFT JOIN whatsapp_numbers n        ON n.id = q.number_id
      LEFT JOIN shopify_catalog_items s   ON s.id = q.product_id
      LEFT JOIN whatsapp_message_logs l   ON l.queue_id = q.id
      LEFT JOIN leads ld                  ON ld.phone = q.customer_phone
        AND ld.source = 'WHATSAPP'
        AND ld.created_at >= $1
      WHERE q.created_at >= $1
      ORDER BY q.created_at DESC
      LIMIT 100
    `, [todayIso]).catch(() => []);

    return rows.map(r => ({
      queue_id:         r.queue_id,
      campaign_id:      r.campaign_id ?? null,
      promo_id:         r.promo_id ?? null,
      customer_phone:   r.customer_phone,
      customer_name:    r.customer_name ?? '—',
      product_sku:      r.product_sku ?? '—',
      product_title:    r.product_title ?? r.product_sku ?? '—',
      queue_status:     r.queue_status,
      skip_reason:      r.skip_reason ?? null,
      sent_at:          r.sent_at ?? null,
      telecaller_phone: r.telecaller_phone ?? '—',
      read:             !!r.read_at,
      replied:          !!r.reply_received,
      reply_message:    r.reply_message ?? null,
      lead_created:     !!r.lead_created,
      message_body:     r.message_body ?? null,
      ai_hook_type:       r.ai_hook_type ?? null,
      ai_cta_used:        r.ai_cta_used ?? null,
      product_image:      r.product_image ?? null,
      product_url:        r.product_url ?? null,
      generated_message:  r.generated_message ?? null,
    }));
  }

  // ── Section E: Telecaller Performance ─────────────────────────────────────

  private async _getTelecallerPerformance(todayIso: string) {
    const since = new Date(todayIso);
    const numbers = await this.numberRepo.find({ order: { created_at: 'ASC' } });

    const campRows = await this.ds.query<{ telecaller_number_id: string; id: string; promo_id: string | null }[]>(`
      SELECT DISTINCT ON (telecaller_number_id) telecaller_number_id, id, promo_id
      FROM marketing_campaigns
      WHERE is_promotion = true AND telecaller_number_id IS NOT NULL AND created_at >= $1
      ORDER BY telecaller_number_id, created_at DESC
    `, [todayIso]).catch(() => []);
    const campMap = new Map<string, { id: string; promo_id: string | null }>(
      campRows.map(c => [c.telecaller_number_id, c] as [string, { id: string; promo_id: string | null }]),
    );

    const assignedRows = await this.ds.query<{ number_id: string; cnt: string }[]>(`
      SELECT number_id, COUNT(*)::int AS cnt
      FROM whatsapp_message_queue
      WHERE created_at >= $1
      GROUP BY number_id
    `, [todayIso]).catch(() => []);
    const assignedMap = new Map<string, number>(
      assignedRows.map(r => [r.number_id, parseInt(r.cnt, 10)] as [string, number]),
    );

    return Promise.all(
      numbers.filter(n => n.is_active).map(async n => {
        const [m, lastRows] = await Promise.all([
          fetchAuthoritativeMetrics(this.ds, since, { numberId: n.id }),
          this.ds.query<{ last_activity: string | null }[]>(`
            SELECT MAX(COALESCE(l.sent_at, q.sent_at, q.updated_at, q.created_at)) AS last_activity
            FROM whatsapp_message_queue q
            LEFT JOIN whatsapp_message_logs l ON l.queue_id = q.id
            WHERE q.number_id = $1 AND q.created_at >= $2
          `, [n.id, todayIso]).catch(() => [{ last_activity: null }]),
        ]);
        const camp = campMap.get(n.id);
        const releaseAllowance = getReleaseAllowance(n.warmup_level);
        const waStatus = this.whatsAppService.getNumberWaStatus(n.id);
        const remaining = Math.max(0, releaseAllowance - m.sent);
        const queueWaiting = m.queue_pending;
        const health = await this.warmupProgression.getHealthMetrics(n.id);
        const warnings = detectWarnings(health);
        return {
          number_id:          n.id,
          phone:              n.phone,
          name:               n.name ?? '—',
          connection_status:  waStatus.number_state,
          connected:          waStatus.number_state === NumberConnectionState.CONNECTED,
          wa_state:           waStatus.waState,
          warmup_level:       n.warmup_level,
          warmup_label:       getWarmupLabel(n.warmup_level),
          campaign_id:        camp?.id ?? null,
          promo_id:           camp?.promo_id ?? null,
          release_allowance:  releaseAllowance,
          daily_cap:          releaseAllowance,
          messages_released:  m.sent,
          sent_today:         m.sent,
          delivered_today:    m.delivered,
          read_today:         m.read,
          replies_today:      m.replied,
          failed_today:       m.failed,
          skipped_today:      m.skipped,
          remaining_today:    remaining,
          remaining_allowance: remaining,
          queue_assigned:     assignedMap.get(n.id) ?? 0,
          queue_waiting:      queueWaiting,
          queue_pending:      queueWaiting,
          health_score:       health.healthScore,
          warnings,
          last_activity:      lastRows[0]?.last_activity ?? null,
          pending:            queueWaiting,
          sent:               m.sent,
          failed:             m.failed,
          skipped:            m.skipped,
          total:              assignedMap.get(n.id) ?? 0,
          capacity_remaining: remaining,
        };
      }),
    );
  }

  // ── Section F: Today's Queue ────────────────────────────────────────────────
  private async _getTodayQueueSummary(todayIso: string) {
    const rows = await this.ds.query<{
      status:       string;
      number_phone: string | null;
      number_name:  string | null;
      cnt:          string;
    }[]>(`
      SELECT
        q.status,
        n.phone AS number_phone,
        n.name  AS number_name,
        COUNT(*) AS cnt
      FROM whatsapp_message_queue q
      LEFT JOIN whatsapp_numbers n ON n.id = q.number_id
      WHERE q.created_at >= $1
      GROUP BY q.status, n.phone, n.name
      ORDER BY n.phone, q.status
    `, [todayIso]).catch(() => []);

    const stuckRows = await this.ds.query<{ oldest: string | null }[]>(`
      SELECT MIN(q.scheduled_at) AS oldest
      FROM whatsapp_message_queue q
      WHERE q.status = 'pending'
        AND q.created_at >= $1
        AND q.scheduled_at <= NOW()
    `, [todayIso]).catch(() => []);
    const oldestPending = stuckRows[0]?.oldest ?? null;
    const stuckMinutes  = oldestPending
      ? Math.floor((Date.now() - new Date(oldestPending).getTime()) / 60_000)
      : 0;

    return {
      rows: rows.map(r => ({
        status:       r.status,
        number_phone: r.number_phone ?? 'unassigned',
        number_name:  r.number_name  ?? '—',
        count:        parseInt(r.cnt, 10),
      })),
      oldest_pending_minutes: stuckMinutes,
    };
  }

  // ── Historical Queue (all-time, for stuck detection + collapsible view) ───────

  private async _getAllTimeQueue() {
    const rows = await this.ds.query<{
      status:       string;
      number_phone: string | null;
      number_name:  string | null;
      cnt:          string;
    }[]>(`
      SELECT
        q.status,
        n.phone AS number_phone,
        n.name  AS number_name,
        COUNT(*) AS cnt
      FROM whatsapp_message_queue q
      LEFT JOIN whatsapp_numbers n ON n.id = q.number_id
      GROUP BY q.status, n.phone, n.name
      ORDER BY n.phone, q.status
    `).catch(() => []);

    const stuckRows = await this.ds.query<{ oldest: string | null }[]>(`
      SELECT MIN(q.scheduled_at) AS oldest
      FROM whatsapp_message_queue q
      WHERE q.status = 'pending' AND q.scheduled_at <= NOW()
    `).catch(() => []);
    const oldestPending = stuckRows[0]?.oldest ?? null;
    const stuckMinutes  = oldestPending
      ? Math.floor((Date.now() - new Date(oldestPending).getTime()) / 60_000)
      : 0;

    return {
      rows: rows.map(r => ({
        status:       r.status,
        number_phone: r.number_phone ?? 'unassigned',
        number_name:  r.number_name  ?? '—',
        count:        parseInt(r.cnt, 10),
      })),
      oldest_pending_minutes: stuckMinutes,
    };
  }

  // ── Section G: Product Rotation ─────────────────────────────────────────────

  private async _getProductRotation(todayIso: string) {
    const rows = await this.ds.query<{
      sku:              string;
      product_name:     string | null;
      campaign_id:      string | null;
      promo_id:         string | null;
      telecaller_phone: string | null;
      customers_reached: string;
      times_used:       string;
    }[]>(`
      SELECT
        r.sku,
        s.item_name                                AS product_name,
        r.campaign_id,
        c.promo_id,
        n.phone                                    AS telecaller_phone,
        COUNT(DISTINCT r.telecaller_number_id)     AS times_used,
        COUNT(DISTINCT r.id)                       AS customers_reached
      FROM promotion_product_rotation r
      LEFT JOIN shopify_catalog_items s  ON s.id = r.product_id
      LEFT JOIN whatsapp_numbers n       ON n.id = r.telecaller_number_id
      LEFT JOIN marketing_campaigns c    ON c.id = r.campaign_id
      WHERE r.sent_at >= $1
      GROUP BY r.sku, s.item_name, r.campaign_id, c.promo_id, n.phone
      ORDER BY customers_reached DESC
      LIMIT 30
    `, [todayIso]).catch(() => []);

    return rows.map(r => ({
      sku:              r.sku,
      product_name:     r.product_name ?? r.sku,
      campaign_id:      r.campaign_id ?? null,
      promo_id:         r.promo_id ?? null,
      telecaller_phone: r.telecaller_phone ?? '—',
      times_used:       parseInt(r.times_used        ?? '0', 10),
      customers_reached: parseInt(r.customers_reached ?? '0', 10),
    }));
  }

  // ── Section H: Number Utilization ─────────────────────────────────────────

  private async _getNumberUtilization(todayIso: string) {
    const since = new Date(todayIso);
    const numbers = await this.numberRepo.find({ order: { created_at: 'ASC' } });

    return Promise.all(numbers.map(async n => {
      const releaseAllowance = getReleaseAllowance(n.warmup_level);
      const status      = this.whatsAppService.getNumberWaStatus(n.id);
      const metrics     = await fetchAuthoritativeMetrics(this.ds, since, { numberId: n.id });
      const sentToday   = metrics.sent;
      const remaining   = Math.max(0, releaseAllowance - sentToday);
      const health      = await this.warmupProgression.getHealthMetrics(n.id);
      return {
        id:                n.id,
        phone:             n.phone,
        name:              n.name,
        warmup_level:      n.warmup_level,
        warmup_label:      getWarmupLabel(n.warmup_level),
        last_connected_at: n.last_connected_at,
        is_active:         n.is_active,
        wa_state:          status.waState,
        number_state:      status.number_state,
        connected:         status.number_state === NumberConnectionState.CONNECTED,
        fully_operational: status.fullyOperational,
        daily_sent:        sentToday,
        sent_today:        sentToday,
        delivered_today:   metrics.delivered,
        read_today:        metrics.read,
        replies_today:     metrics.replied,
        failed_today:      metrics.failed,
        release_allowance: releaseAllowance,
        queue_capacity:    getMatureDailyCapacity(),
        queue_waiting:     metrics.queue_pending,
        health_score:      health.healthScore,
        warnings:          detectWarnings(health),
        remaining_today:   remaining,
        remaining_allowance: remaining,
        utilization_pct:   releaseAllowance > 0 ? Math.round((sentToday / releaseAllowance) * 100) : 0,
      };
    }));
  }

  // ── Section I: Log Stream ──────────────────────────────────────────────────

  private async _getLogStream(todayIso: string) {
    const rows = await this.ds.query<{
      id:              string;
      event:           string;
      reason:          string | null;
      created_at:      string;
      campaign_id:     string | null;
      promo_id:        string | null;
      number_id:       string | null;
      telecaller_phone: string | null;
      customer_phone:  string | null;
      metadata:        unknown;
    }[]>(`
      SELECT
        al.id, al.event, al.reason, al.created_at,
        al.campaign_id,
        c.promo_id,
        al.number_id,
        n.phone  AS telecaller_phone,
        al.customer_phone,
        al.metadata
      FROM engine_audit_logs al
      LEFT JOIN marketing_campaigns c ON c.id = al.campaign_id
      LEFT JOIN whatsapp_numbers n    ON n.id = al.number_id
      WHERE al.created_at >= $1
      ORDER BY al.created_at DESC
      LIMIT 60
    `, [todayIso]).catch(() => []);

    return rows.map(r => {
      const ts = new Date(r.created_at);
      return {
        id:              r.id,
        event:           r.event,
        reason:          r.reason ?? '',
        created_at:      r.created_at,
        log_date:        ts.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        log_time:        ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        campaign_id:     r.campaign_id  ?? null,
        promo_id:        r.promo_id     ?? null,
        number_id:       r.number_id    ?? null,
        telecaller_phone: r.telecaller_phone ?? null,
        customer_phone:  r.customer_phone ?? null,
        metadata:        r.metadata,
      };
    });
  }

  // ── Today's Queue by Telecaller (ground truth — no campaign_id dependency) ──
  // Used to surface activity in Section C even when campaign_id IS NULL on queue rows.

  private async _getTodayQueueByTelecaller(todayIso: string) {
    const rows = await this.ds.query<{
      number_id:        string;
      telecaller_phone: string | null;
      number_name:      string | null;
      total:            string;
      sent:             string;
      pending:          string;
      failed:           string;
      skipped:          string;
      product_skus:     string[] | null;
    }[]>(`
      SELECT
        eff.effective_number_id                                                    AS number_id,
        n.phone                                                                    AS telecaller_phone,
        n.name                                                                     AS number_name,
        COUNT(q.id)                                                                AS total,
        COUNT(q.id) FILTER (WHERE q.status IN ('sent','delivered','read','replied')) AS sent,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')                            AS pending,
        COUNT(q.id) FILTER (WHERE q.status = 'failed')                             AS failed,
        COUNT(q.id) FILTER (WHERE q.status = 'skipped')                            AS skipped,
        array_agg(DISTINCT q.message_payload->>'product_sku')
          FILTER (WHERE (q.message_payload->>'product_sku') IS NOT NULL
            AND (q.message_payload->>'product_sku') != '')                         AS product_skus
      FROM (
        SELECT
          q.id,
          COALESCE(q.actual_sender_number_id, q.number_id) AS effective_number_id
        FROM whatsapp_message_queue q
        WHERE q.created_at >= $1
      ) eff
      JOIN whatsapp_numbers n  ON n.id = eff.effective_number_id
      JOIN whatsapp_message_queue q ON q.id = eff.id
      GROUP BY eff.effective_number_id, n.phone, n.name
      HAVING COUNT(q.id) > 0
      ORDER BY total DESC
    `, [todayIso]).catch(() => []);

    return rows.map(r => ({
      number_id:        r.number_id,
      telecaller_phone: r.telecaller_phone ?? '—',
      number_name:      r.number_name ?? '—',
      total:            parseInt(r.total   ?? '0', 10),
      sent:             parseInt(r.sent    ?? '0', 10),
      pending:          parseInt(r.pending ?? '0', 10),
      failed:           parseInt(r.failed  ?? '0', 10),
      skipped:          parseInt(r.skipped ?? '0', 10),
      product_skus:     r.product_skus ?? [],
    }));
  }

  // ── Queue Inspection (paginated, per-telecaller) ───────────────────────────

  async getQueueInspection(numberId: string, offset = 0, limit = 10) {
    const { start: today } = getIstDayBounds();
    const todayIso = today.toISOString();

    const [rows, countRows] = await Promise.all([
      this.ds.query<{
        queue_id:          string;
        customer_phone:    string;
        status:            string;
        proposed_send_time: string | null;
        actual_send_time:  string | null;
        campaign_id:       string | null;
        created_at:        string;
        product_sku:       string | null;
        generated_message: string | null;
        ai_metadata:       unknown;
        quality:           unknown;
      }[]>(`
        SELECT
          q.id                                          AS queue_id,
          q.customer_phone,
          q.status,
          q.scheduled_at                                AS proposed_send_time,
          q.sent_at                                     AS actual_send_time,
          q.campaign_id,
          q.created_at,
          q.message_payload->>'product_sku'             AS product_sku,
          q.message_payload->>'generated_message'       AS generated_message,
          q.message_payload->'ai_metadata'              AS ai_metadata,
          q.message_payload->'quality'                  AS quality
        FROM whatsapp_message_queue q
        WHERE q.created_at >= $1
          AND COALESCE(q.actual_sender_number_id, q.number_id) = $2
        ORDER BY q.scheduled_at ASC
        LIMIT $3 OFFSET $4
      `, [todayIso, numberId, limit, offset]).catch(() => []),

      this.ds.query<{ total: string }[]>(`
        SELECT COUNT(*) AS total
        FROM whatsapp_message_queue q
        WHERE q.created_at >= $1
          AND COALESCE(q.actual_sender_number_id, q.number_id) = $2
      `, [todayIso, numberId]).catch(() => [{ total: '0' }]),
    ]);

    const total = parseInt(countRows[0]?.total ?? '0', 10);

    return {
      number_id: numberId,
      total,
      offset,
      limit,
      rows: rows.map(r => ({
        queue_id:           r.queue_id,
        customer_phone_masked: r.customer_phone
          ? '****' + r.customer_phone.slice(-4)
          : '—',
        status:             r.status,
        proposed_send_time: r.proposed_send_time ?? null,
        actual_send_time:   r.actual_send_time   ?? null,
        campaign_id:        r.campaign_id        ?? null,
        created_at:         r.created_at,
        product_sku:        r.product_sku        ?? null,
        generated_message:  r.generated_message  ?? null,
        ai_metadata:        r.ai_metadata        ?? null,
        quality:            r.quality            ?? null,
      })),
    };
  }

  // ── Warnings ───────────────────────────────────────────────────────────────

  private _computeWarnings(
    activity: Awaited<ReturnType<typeof this._getTodayActivity>>,
    status:   Awaited<ReturnType<typeof this._getEngineStatus>>,
    queue:    Awaited<ReturnType<typeof this._getTodayQueueSummary>>,
  ): string[] {
    const now          = new Date();
    const hour         = now.getHours();
    const inSendWindow = hour >= 10 && hour < 18;
    const warnings: string[] = [];

    if (status.engine_enabled && !status.engine_ran_today && hour >= 9) {
      warnings.push('No AI queue built today — autonomous engine may not have run');
    }
    if (status.connected_numbers === 0) {
      warnings.push('No WhatsApp numbers connected — no messages can be sent');
    }
    if (queue.oldest_pending_minutes > 15 && inSendWindow) {
      warnings.push(`Queue stuck — oldest pending item is ${queue.oldest_pending_minutes} minutes old`);
    }
    const total = activity.messages_sent + activity.failures;
    if (total >= 5) {
      const failRate = (activity.failures / total) * 100;
      if (failRate > 20) {
        warnings.push(`High failure rate: ${Math.round(failRate)}% — check number health`);
      }
    }
    return warnings;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineSettingsService } from './engine-settings.service';
import { getActiveLimits } from '../shared/number-limits';

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
  ) {}

  async getDashboard() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const [
      engineStatus,
      todayActivity,
      campaigns,
      campaignQueueDetail,
      telecallerPerformance,
      validationQueue,
      historicalQueue,
      productRotation,
      numberUtilization,
      logStream,
      todayQueueByTelecaller,
    ] = await Promise.all([
      this._getEngineStatus(todayIso),
      this._getTodayActivity(todayIso),
      this._getAiCampaigns(todayIso),
      this._getCampaignQueueDetail(todayIso),
      this._getTelecallerPerformance(todayIso),
      this._getTodayValidationQueue(),
      this._getAllTimeQueue(),
      this._getProductRotation(todayIso),
      this._getNumberUtilization(),
      this._getLogStream(),
      this._getTodayQueueByTelecaller(todayIso),
    ]);

    const isInconsistent = todayActivity.queue_items > 0 && todayActivity.campaigns_created === 0;
    // Warnings use the all-time queue for stuck-pending detection (production monitoring)
    const warnings = this._computeWarnings(todayActivity, engineStatus, historicalQueue);

    return {
      engine_status:             engineStatus,
      today_activity:            todayActivity,
      campaigns,
      campaign_queue_detail:     campaignQueueDetail,
      telecaller_performance:    telecallerPerformance,
      live_queue:                validationQueue,   // today's validation rows only
      historical_queue:          historicalQueue,   // all-time production rows (collapsible)
      product_rotation:          productRotation,
      number_utilization:        numberUtilization,
      log_stream:                logStream,
      today_queue_by_telecaller: todayQueueByTelecaller,
      is_inconsistent:           isInconsistent,
      warnings,
      as_of:                     new Date().toISOString(),
    };
  }

  // ── Section A: Engine Status ───────────────────────────────────────────────

  private async _getEngineStatus(todayIso: string) {
    const autoAiMode      = await this.engineSettings.getAutoAiMode().catch(() => false);
    const allNumbers      = await this.numberRepo.find();
    const connectedNumbers = allNumbers.filter(n => this.whatsAppService.isConnected(n.id));
    const waConnected     = connectedNumbers.length > 0;

    const lastRunRows = await this.ds.query<{ created_at: string; metadata: unknown }[]>(
      `SELECT created_at, metadata FROM engine_audit_logs
       WHERE event = 'QUEUE_CREATED'
       ORDER BY created_at DESC LIMIT 1`,
    ).catch(() => []);
    const lastAiRun = lastRunRows[0]?.created_at ?? null;

    const now  = new Date();
    const next = new Date(now);
    next.setHours(8, 30, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);

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
          connected:       waStatus.connected,
          wa_state:        waStatus.waState,
          partial_session: waStatus.partial_session,
        };
      }),
    };
  }

  // ── Section B: Today's Activity ────────────────────────────────────────────
  // Counts ALL today's queue rows — including campaign_id=NULL (pre-campaign) ones.

  private async _getTodayActivity(todayIso: string) {
    const rows = await this.ds.query<{
      campaigns_today:   string;
      queue_items_today: string;
      sent_today:        string;
      failed_today:      string;
      skipped_today:     string;
    }[]>(`
      SELECT
        (SELECT COUNT(*) FROM marketing_campaigns
         WHERE is_promotion = true AND created_at >= $1)           AS campaigns_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue
         WHERE created_at >= $1)                                    AS queue_items_today,

        (SELECT COUNT(*) FROM whatsapp_message_logs
         WHERE created_at >= $1)                                    AS sent_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue
         WHERE status = 'failed' AND updated_at >= $1)             AS failed_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue
         WHERE status = 'skipped' AND updated_at >= $1)            AS skipped_today
    `, [todayIso]).catch(() => []);

    const r = rows[0] ?? {};

    const repliesRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM whatsapp_replies WHERE received_at >= $1`, [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    const leadsRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM leads WHERE source = 'WHATSAPP' AND created_at >= $1`, [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    const queueTotal   = parseInt(r.queue_items_today ?? '0', 10);
    const campaignsVal = parseInt(r.campaigns_today   ?? '0', 10);

    return {
      campaigns_created: campaignsVal,
      // If queue rows exist but campaigns show 0, at least show 1 so the operator knows the engine ran
      campaigns_display: queueTotal > 0 && campaignsVal === 0 ? '—' : campaignsVal,
      queue_items:       queueTotal,
      messages_sent:     parseInt(r.sent_today    ?? '0', 10),
      replies:           parseInt(repliesRows[0]?.cnt ?? '0', 10),
      leads_created:     parseInt(leadsRows[0]?.cnt   ?? '0', 10),
      failures:          parseInt(r.failed_today  ?? '0', 10),
      skipped:           parseInt(r.skipped_today ?? '0', 10),
    };
  }

  // ── Section C: AI Campaigns — TODAY + last 30 days ─────────────────────────

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
        COUNT(q.id) FILTER (WHERE q.status = 'sent')            AS sent,
        COUNT(q.id) FILTER (WHERE q.status = 'delivered')       AS delivered,
        COUNT(q.id) FILTER (WHERE q.status = 'failed')          AS failed,
        COUNT(q.id) FILTER (WHERE q.status = 'skipped')         AS skipped,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')         AS pending
      FROM marketing_campaigns c
      LEFT JOIN whatsapp_message_queue q ON q.campaign_id = c.id
      LEFT JOIN whatsapp_numbers n ON n.id = c.telecaller_number_id
      WHERE c.is_promotion = true
        AND c.created_at >= NOW() - INTERVAL '30 days'
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
      GROUP BY l.campaign_id
    `).catch(() => []);
    const replyMap = new Map<string, number>(
      replyRows.map(r => [r.campaign_id, parseInt(r.cnt, 10)] as [string, number]),
    );

    // Leads per campaign
    const leadRows = await this.ds.query<{ campaign_id: string; cnt: string }[]>(`
      SELECT l.campaign_id, COUNT(*) AS cnt
      FROM leads ld
      JOIN whatsapp_message_logs l ON l.customer_phone = ld.phone
        AND l.campaign_id IS NOT NULL
      WHERE ld.source = 'WHATSAPP'
      GROUP BY l.campaign_id
    `).catch(() => []);
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
        q.sent_at,
        COALESCE(q.actual_sender_phone, n.phone)   AS telecaller_phone,
        l.read_at,
        l.reply_received,
        l.reply_message,
        (r.id IS NOT NULL)                         AS lead_created,
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
      LEFT JOIN whatsapp_replies r        ON r.customer_phone = q.customer_phone
        AND r.received_at >= $1
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
    const numbers = await this.numberRepo.find({ order: { created_at: 'ASC' } });

    const rows = await this.ds.query<{
      number_id:   string;
      campaign_id: string | null;
      promo_id:    string | null;
      pending:     string;
      sent:        string;
      failed:      string;
      skipped:     string;
      total:       string;
    }[]>(`
      SELECT
        n.id                                                     AS number_id,
        c.id                                                     AS campaign_id,
        c.promo_id,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')         AS pending,
        COUNT(q.id) FILTER (WHERE q.status = 'sent')            AS sent,
        COUNT(q.id) FILTER (WHERE q.status = 'failed')          AS failed,
        COUNT(q.id) FILTER (WHERE q.status = 'skipped')         AS skipped,
        COUNT(q.id)                                              AS total
      FROM whatsapp_numbers n
      LEFT JOIN marketing_campaigns c ON c.telecaller_number_id = n.id
        AND c.is_promotion = true
        AND c.created_at >= $1
      LEFT JOIN whatsapp_message_queue q ON q.number_id = n.id
        AND q.created_at >= $1
      GROUP BY n.id, c.id, c.promo_id
      ORDER BY n.phone
    `, [todayIso]).catch(() => []);

    const numberMap = new Map(numbers.map(n => [n.id, n]));

    return rows.map(r => {
      const n       = numberMap.get(r.number_id);
      const limits  = n ? getActiveLimits(n.warmup_level) : { daily: 0 };
      const sent    = parseInt(r.sent ?? '0', 10);
      const remaining = n ? Math.max(0, limits.daily - (n.daily_sent)) : 0;
      return {
        number_id:        r.number_id,
        phone:            n?.phone ?? '—',
        name:             n?.name  ?? '—',
        campaign_id:      r.campaign_id ?? null,
        promo_id:         r.promo_id    ?? null,
        pending:          parseInt(r.pending ?? '0', 10),
        sent,
        failed:           parseInt(r.failed  ?? '0', 10),
        skipped:          parseInt(r.skipped ?? '0', 10),
        total:            parseInt(r.total   ?? '0', 10),
        daily_cap:        limits.daily,
        capacity_remaining: remaining,
      };
    });
  }

  // ── Section F: Today Validation Queue ────────────────────────────────────────
  // Scoped to is_validation=true + created today. Zero means cleanup succeeded.

  private async _getTodayValidationQueue() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
      WHERE (q.message_payload->>'is_validation')::boolean = true
        AND q.created_at >= $1
      GROUP BY q.status, n.phone, n.name
      ORDER BY n.phone, q.status
    `, [todayStart]).catch(() => []);

    const stuckRows = await this.ds.query<{ oldest: string | null }[]>(`
      SELECT MIN(q.scheduled_at) AS oldest
      FROM whatsapp_message_queue q
      WHERE (q.message_payload->>'is_validation')::boolean = true
        AND q.status = 'pending'
        AND q.created_at >= $1
        AND q.scheduled_at <= NOW()
    `, [todayStart]).catch(() => []);
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

  private async _getNumberUtilization() {
    const numbers = await this.numberRepo.find({ order: { created_at: 'ASC' } });

    return numbers.map(n => {
      const limits    = getActiveLimits(n.warmup_level);
      const status    = this.whatsAppService.getNumberWaStatus(n.id);
      const remaining = Math.max(0, limits.daily - n.daily_sent);
      return {
        id:                n.id,
        phone:             n.phone,
        name:              n.name,
        warmup_level:      n.warmup_level,
        last_connected_at: n.last_connected_at,
        is_active:         n.is_active,
        wa_state:          status.waState,
        connected:         status.connected,
        fully_operational: status.fullyOperational,
        daily_sent:        n.daily_sent,
        daily_cap:         limits.daily,
        remaining_today:   remaining,
        utilization_pct:   limits.daily > 0 ? Math.round((n.daily_sent / limits.daily) * 100) : 0,
      };
    });
  }

  // ── Section I: Log Stream ──────────────────────────────────────────────────

  private async _getLogStream() {
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
      ORDER BY al.created_at DESC
      LIMIT 60
    `).catch(() => []);

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
        n.id                                                              AS number_id,
        n.phone                                                           AS telecaller_phone,
        n.name                                                            AS number_name,
        COUNT(q.id)                                                       AS total,
        COUNT(q.id) FILTER (WHERE q.status = 'sent')                     AS sent,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')                  AS pending,
        COUNT(q.id) FILTER (WHERE q.status = 'failed')                   AS failed,
        COUNT(q.id) FILTER (WHERE q.status = 'skipped')                  AS skipped,
        array_agg(DISTINCT q.message_payload->>'product_sku')
          FILTER (WHERE (q.message_payload->>'product_sku') IS NOT NULL
            AND (q.message_payload->>'product_sku') != '')                AS product_skus
      FROM whatsapp_numbers n
      LEFT JOIN whatsapp_message_queue q ON q.number_id = n.id AND q.created_at >= $1
      GROUP BY n.id, n.phone, n.name
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

  // ── Warnings ───────────────────────────────────────────────────────────────

  private _computeWarnings(
    activity: Awaited<ReturnType<typeof this._getTodayActivity>>,
    status:   Awaited<ReturnType<typeof this._getEngineStatus>>,
    queue:    Awaited<ReturnType<typeof this._getAllTimeQueue>>,
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
    if (activity.messages_sent >= 10 && activity.replies === 0) {
      warnings.push(`${activity.messages_sent} messages sent with zero replies — check inbox`);
    }

    return warnings;
  }
}

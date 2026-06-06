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
      liveQueue,
      productRotation,
      numberUtilization,
      logStream,
    ] = await Promise.all([
      this._getEngineStatus(todayIso),
      this._getTodayActivity(todayIso),
      this._getAiCampaigns(todayIso),
      this._getLiveQueue(),
      this._getProductRotation(todayIso),
      this._getNumberUtilization(),
      this._getLogStream(),
    ]);

    const warnings = this._computeWarnings(todayActivity, engineStatus, liveQueue);

    return {
      engine_status:       engineStatus,
      today_activity:      todayActivity,
      campaigns,
      live_queue:          liveQueue,
      product_rotation:    productRotation,
      number_utilization:  numberUtilization,
      log_stream:          logStream,
      warnings,
      as_of:               new Date().toISOString(),
    };
  }

  // ── Section A: Engine Status ───────────────────────────────────────────────

  private async _getEngineStatus(todayIso: string) {
    const autoAiMode  = await this.engineSettings.getAutoAiMode().catch(() => false);
    const allNumbers  = await this.numberRepo.find();
    const connectedNumbers = allNumbers.filter(n => this.whatsAppService.isConnected(n.id));
    const waConnected = connectedNumbers.length > 0;

    // Last time the autonomous engine created a queue
    const lastRunRows = await this.ds.query<{ created_at: string; metadata: unknown }[]>(
      `SELECT created_at, metadata FROM engine_audit_logs
       WHERE event = 'QUEUE_CREATED'
       ORDER BY created_at DESC LIMIT 1`,
    ).catch(() => []);

    const lastAiRun = lastRunRows[0]?.created_at ?? null;

    // Next 8:30 AM
    const now = new Date();
    const next = new Date(now);
    next.setHours(8, 30, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);

    // Any non-test promotion campaign created today = engine ran today
    const todayCampaignRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM marketing_campaigns
       WHERE is_promotion = true AND test_mode = false AND created_at >= $1`, [todayIso],
    ).catch(() => [{ cnt: '0' }]);
    const engineRanToday = parseInt(todayCampaignRows[0]?.cnt ?? '0', 10) > 0;

    return {
      running:         waConnected && (process.env.WHATSAPP_ENGINE_ENABLED !== 'false'),
      engine_enabled:  process.env.WHATSAPP_ENGINE_ENABLED !== 'false',
      pilot_mode:      process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
      test_only_mode:  process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true',
      autonomous_mode: autoAiMode,
      last_ai_run:     lastAiRun,
      next_ai_run:     next.toISOString(),
      engine_ran_today: engineRanToday,
      total_numbers:    allNumbers.length,
      connected_numbers: connectedNumbers.length,
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

  private async _getTodayActivity(todayIso: string) {
    const rows = await this.ds.query<{
      campaigns_today: string;
      queue_items_today: string;
      sent_today: string;
      failed_today: string;
      skipped_today: string;
    }[]>(`
      SELECT
        (SELECT COUNT(*) FROM marketing_campaigns
         WHERE is_promotion = true AND created_at >= $1) AS campaigns_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue q
         JOIN marketing_campaigns c ON c.id = q.campaign_id
         WHERE c.is_promotion = true AND q.created_at >= $1) AS queue_items_today,

        (SELECT COUNT(*) FROM whatsapp_message_logs
         WHERE sent_at >= $1) AS sent_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue q
         JOIN marketing_campaigns c ON c.id = q.campaign_id
         WHERE c.is_promotion = true AND q.status = 'failed' AND q.updated_at >= $1) AS failed_today,

        (SELECT COUNT(*) FROM whatsapp_message_queue q
         JOIN marketing_campaigns c ON c.id = q.campaign_id
         WHERE c.is_promotion = true AND q.status = 'skipped' AND q.updated_at >= $1) AS skipped_today
    `, [todayIso]).catch(() => []);

    const r = rows[0] ?? {};

    // Replies today from marketing numbers
    const repliesRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM whatsapp_replies WHERE received_at >= $1`, [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    // Leads created from WhatsApp today
    const leadsRows = await this.ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM leads WHERE source = 'WHATSAPP' AND created_at >= $1`, [todayIso],
    ).catch(() => [{ cnt: '0' }]);

    return {
      campaigns_created:  parseInt(r.campaigns_today   ?? '0', 10),
      queue_items:        parseInt(r.queue_items_today ?? '0', 10),
      messages_sent:      parseInt(r.sent_today        ?? '0', 10),
      replies:            parseInt(repliesRows[0]?.cnt ?? '0', 10),
      leads_created:      parseInt(leadsRows[0]?.cnt   ?? '0', 10),
      failures:           parseInt(r.failed_today      ?? '0', 10),
      skipped:            parseInt(r.skipped_today     ?? '0', 10),
    };
  }

  // ── Section C: AI Campaigns Table ──────────────────────────────────────────

  private async _getAiCampaigns(todayIso: string) {
    // Last 30 days of promotion campaigns with per-campaign queue stats
    const rows = await this.ds.query<{
      id: string;
      promo_id: string | null;
      campaign_name: string;
      created_at: string | Date;
      status: string;
      is_promotion: boolean;
      test_mode: boolean;
      total_queue: string;
      sent: string;
      failed: string;
      skipped: string;
      pending: string;
    }[]>(`
      SELECT
        c.id, c.promo_id, c.campaign_name, c.created_at, c.status,
        c.is_promotion, c.test_mode,
        COUNT(q.id)                                              AS total_queue,
        COUNT(q.id) FILTER (WHERE q.status = 'sent')            AS sent,
        COUNT(q.id) FILTER (WHERE q.status = 'delivered')       AS delivered,
        COUNT(q.id) FILTER (WHERE q.status = 'failed')          AS failed,
        COUNT(q.id) FILTER (WHERE q.status = 'skipped')         AS skipped,
        COUNT(q.id) FILTER (WHERE q.status = 'pending')         AS pending
      FROM marketing_campaigns c
      LEFT JOIN whatsapp_message_queue q ON q.campaign_id = c.id
      WHERE c.is_promotion = true
        AND c.test_mode = false
        AND c.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY c.id, c.promo_id, c.campaign_name, c.created_at, c.status, c.is_promotion, c.test_mode
      ORDER BY c.created_at DESC
      LIMIT 20
    `, []).catch(() => []);

    // Replies per campaign
    const replyRows = await this.ds.query<{ campaign_id: string; cnt: string }[]>(`
      SELECT l.campaign_id, COUNT(*) AS cnt
      FROM whatsapp_replies r
      JOIN whatsapp_message_logs l ON l.customer_phone = r.customer_phone
        AND l.number_id = r.number_id
      WHERE l.campaign_id IS NOT NULL
      GROUP BY l.campaign_id
    `).catch(() => []);
    const replyMap = new Map<string, number>(replyRows.map(r => [r.campaign_id as string, parseInt(r.cnt, 10)] as [string, number]));

    return rows.map(r => ({
      id:            r.id,
      promo_id:      r.promo_id ?? `PROMO-${new Date(r.created_at).toISOString().slice(0, 10).replace(/-/g, '')}-????`,
      campaign_name: r.campaign_name,
      created_at:    r.created_at,
      status:        r.status,
      test_mode:     r.test_mode,
      total_queue:   parseInt(r.total_queue ?? '0', 10),
      sent:          parseInt(r.sent        ?? '0', 10),
      failed:        parseInt(r.failed      ?? '0', 10),
      skipped:       parseInt(r.skipped     ?? '0', 10),
      pending:       parseInt(r.pending     ?? '0', 10),
      replies:       replyMap.get(r.id) ?? 0,
    }));
  }

  // ── Section D: Live Queue ──────────────────────────────────────────────────

  private async _getLiveQueue() {
    const rows = await this.ds.query<{
      status: string;
      number_phone: string | null;
      number_name: string | null;
      cnt: string;
    }[]>(`
      SELECT
        q.status,
        n.phone  AS number_phone,
        n.name   AS number_name,
        COUNT(*) AS cnt
      FROM whatsapp_message_queue q
      JOIN marketing_campaigns c ON c.id = q.campaign_id
      JOIN whatsapp_numbers n ON n.id = q.number_id
      WHERE c.is_promotion = true
      GROUP BY q.status, n.phone, n.name
      ORDER BY n.phone, q.status
    `).catch(() => []);

    // Oldest pending item timestamp (to detect stuck queue)
    const stuckRows = await this.ds.query<{ oldest: string | null }[]>(`
      SELECT MIN(q.scheduled_at) AS oldest
      FROM whatsapp_message_queue q
      JOIN marketing_campaigns c ON c.id = q.campaign_id
      WHERE c.is_promotion = true AND q.status = 'pending'
        AND q.scheduled_at <= NOW()
    `).catch(() => []);
    const oldestPending = stuckRows[0]?.oldest ?? null;
    const stuckMinutes = oldestPending
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

  // ── Section E: Product Rotation ────────────────────────────────────────────

  private async _getProductRotation(todayIso: string) {
    const rows = await this.ds.query<{
      sku: string;
      product_name: string | null;
      times_used: string;
      number_count: string;
    }[]>(`
      SELECT
        r.sku,
        s."itemName" AS product_name,
        COUNT(*)                          AS times_used,
        COUNT(DISTINCT r.telecaller_number_id) AS number_count
      FROM promotion_product_rotation r
      LEFT JOIN shopify_catalog_items s ON s.id = r.product_id
      WHERE r.sent_at >= $1
      GROUP BY r.sku, s."itemName"
      ORDER BY times_used DESC
      LIMIT 20
    `, [todayIso]).catch(() => []);

    return rows.map(r => ({
      sku:          r.sku,
      product_name: r.product_name ?? r.sku,
      times_used:   parseInt(r.times_used   ?? '0', 10),
      number_count: parseInt(r.number_count ?? '0', 10),
    }));
  }

  // ── Section F: Number Utilization ─────────────────────────────────────────

  private async _getNumberUtilization() {
    const numbers = await this.numberRepo.find({ order: { created_at: 'ASC' } });

    return numbers.map(n => {
      const limits    = getActiveLimits(n.warmup_level);
      const status    = this.whatsAppService.getNumberWaStatus(n.id);
      const remaining = Math.max(0, limits.daily - n.daily_sent);
      return {
        id:               n.id,
        phone:            n.phone,
        name:             n.name,
        warmup_level:     n.warmup_level,
        last_connected_at: n.last_connected_at,
        is_active:        n.is_active,
        wa_state:         status.waState,
        connected:        status.connected,
        fully_operational: status.fullyOperational,
        daily_sent:       n.daily_sent,
        daily_cap:        limits.daily,
        remaining_today:  remaining,
        utilization_pct:  limits.daily > 0 ? Math.round((n.daily_sent / limits.daily) * 100) : 0,
      };
    });
  }

  // ── Section G: AI Log Stream ───────────────────────────────────────────────

  private async _getLogStream() {
    const rows = await this.ds.query<{
      id: string;
      event: string;
      reason: string | null;
      created_at: string;
      campaign_id: string | null;
      number_id: string | null;
      customer_phone: string | null;
      metadata: unknown;
    }[]>(`
      SELECT id, event, reason, created_at, campaign_id, number_id, customer_phone, metadata
      FROM engine_audit_logs
      ORDER BY created_at DESC
      LIMIT 50
    `).catch(() => []);

    return rows.map(r => ({
      id:             r.id,
      event:          r.event,
      reason:         r.reason,
      created_at:     r.created_at,
      campaign_id:    r.campaign_id,
      number_id:      r.number_id,
      customer_phone: r.customer_phone,
      metadata:       r.metadata,
    }));
  }

  // ── Warnings computation ────────────────────────────────────────────────────

  private _computeWarnings(
    activity: Awaited<ReturnType<typeof this._getTodayActivity>>,
    status:   Awaited<ReturnType<typeof this._getEngineStatus>>,
    queue:    Awaited<ReturnType<typeof this._getLiveQueue>>,
  ): string[] {
    const now = new Date();
    const hour = now.getHours();
    const inSendWindow = hour >= 10 && hour < 18;
    const warnings: string[] = [];

    if (status.engine_enabled && !status.engine_ran_today && hour >= 9) {
      warnings.push('No AI campaign created today — autonomous engine may not have run');
    }
    if (status.connected_numbers === 0) {
      warnings.push('No WhatsApp numbers connected — no messages can be sent');
    }
    if (queue.oldest_pending_minutes > 15 && inSendWindow) {
      warnings.push(`Queue stuck — oldest pending item is ${queue.oldest_pending_minutes} minutes old`);
    }
    const total = activity.messages_sent + activity.failures;
    if (total >= 5 && total > 0) {
      const failRate = (activity.failures / total) * 100;
      if (failRate > 20) {
        warnings.push(`High failure rate: ${Math.round(failRate)}% — check number health`);
      }
    }
    if (activity.messages_sent >= 10 && activity.replies === 0) {
      warnings.push(`${activity.messages_sent} messages sent today with zero replies — check inbox`);
    }

    return warnings;
  }
}

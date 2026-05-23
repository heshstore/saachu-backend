import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan } from 'typeorm';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { QueueStatus } from '../entities/enums';
import { TimingAiService } from '../ai/timing-ai.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';

export interface QueuePatternReport {
  total_pending: number;
  stuck_processing: number;
  retry_loops: number;
  duplicate_phones: { phone: string; count: number }[];
  outside_window: number;
  template_distribution: { template_id: string | null; count: number }[];
  number_distribution: { number_id: string | null; count: number }[];
  timing_by_hour: Record<string, number>;
}

export interface DeliveryFlowReport {
  since: string;
  pending: number;
  processing: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  delivery_rate_pct: number;
  read_rate_pct: number;
  reply_rate_pct: number;
  fail_rate_pct: number;
}

export interface ValidationReport {
  env: {
    engine_enabled: boolean;
    dry_run_mode: boolean;
    test_only_mode: boolean;
    pilot_mode: boolean;
    test_bypass_send_window: boolean;
  };
  server: {
    timezone: string;
    local_time: string;
    send_window_active: boolean;
    next_window_start: string;
  };
  wa: {
    connected: boolean;
  };
  test_contacts: {
    count: number;
    phones: string[];
  };
  catalog: {
    active_templates: number;
    active_campaigns: number;
    pending_queue_items: number;
  };
  queue: QueuePatternReport;
  delivery_flow: DeliveryFlowReport;
  recent_audit_events: { event: string; reason: string | null; created_at: string }[];
  anomalies: string[];
}

const WINDOW_START = 10 * 60;
const WINDOW_END   = 17 * 60 + 30;
const STUCK_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class ValidateService {
  private readonly logger = new Logger(ValidateService.name);

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private readonly queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(MarketingAudience)
    private readonly audienceRepo: Repository<MarketingAudience>,
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly timingAi: TimingAiService,
    private readonly whatsAppService: MarketingWhatsAppService,
  ) {}

  async getValidationReport(): Promise<ValidationReport> {
    const [queuePattern, deliveryFlow, testContacts, recentAuditEvents, catalogRows] = await Promise.all([
      this._analyzeQueuePatterns(),
      this._getDeliveryFlow(),
      this.audienceRepo.find({ where: { is_test_contact: true }, select: ['phone'] }),
      this._getRecentAuditEvents(),
      this.ds.query(`
        SELECT
          (SELECT COUNT(*)::int FROM marketing_templates  WHERE is_active = true)                                     AS active_templates,
          (SELECT COUNT(*)::int FROM marketing_campaigns  WHERE status NOT IN ('cancelled','completed'))              AS active_campaigns,
          (SELECT COUNT(*)::int FROM whatsapp_message_queue WHERE status = 'pending')                                 AS pending_queue_items
      `),
    ]);

    // Log every test contact's raw DB values so mismatches are visible in server logs
    if (testContacts.length > 0) {
      const fullRows = await this.audienceRepo.find({ where: { is_test_contact: true } });
      for (const r of fullRows) {
        this.logger.log(
          `[MKT_AUDIENCE_FETCH] validate_report test_contact ` +
          `id=${r.id} phone=${JSON.stringify(r.phone)} ` +
          `is_whatsapp_valid=${r.is_whatsapp_valid} quality_score=${r.quality_score} ` +
          `opt_out=${r.opt_out} cooldown_until=${r.cooldown_until?.toISOString() ?? 'NULL'}`,
        );
      }
    }

    const now = new Date();
    const sendWindowActive = this.timingAi.isWithinSendWindow();
    const nextWindow = this.timingAi.getNextWindowStart();

    const anomalies: string[] = [];

    if (!process.env.WHATSAPP_ENGINE_ENABLED || process.env.WHATSAPP_ENGINE_ENABLED === 'false') {
      anomalies.push('Engine is DISABLED — set WHATSAPP_ENGINE_ENABLED=true to enable');
    }
    if (!this.whatsAppService.isAnyConnected()) {
      anomalies.push('WhatsApp is not connected — check session status');
    }
    if (queuePattern.stuck_processing > 0) {
      anomalies.push(`${queuePattern.stuck_processing} item(s) stuck in PROCESSING > 5 min — watchdog will recover these`);
    }
    if (queuePattern.retry_loops > 0) {
      anomalies.push(`${queuePattern.retry_loops} item(s) have 3+ failed attempts — investigate send failures`);
    }
    if (queuePattern.duplicate_phones.length > 0) {
      anomalies.push(`${queuePattern.duplicate_phones.length} phone(s) queued more than once`);
    }
    if (queuePattern.outside_window > 0) {
      anomalies.push(`${queuePattern.outside_window} queue item(s) scheduled outside the 10am–5:30pm window`);
    }
    if (testContacts.length === 0 && process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true') {
      anomalies.push('TEST_ONLY mode is active but no test contacts are configured');
    }
    const catalogData = catalogRows?.[0] ?? { active_templates: 0, active_campaigns: 0, pending_queue_items: 0 };
    if (catalogData.active_templates === 0) {
      anomalies.push('No active templates — queue cannot build. Restart backend to auto-create the default test template.');
    }
    if (queuePattern.total_pending === 0 && process.env.WHATSAPP_ENGINE_ENABLED === 'true') {
      anomalies.push('Queue is empty — daily queue may not have been built yet');
    }
    if (deliveryFlow.fail_rate_pct > 30 && deliveryFlow.sent > 5) {
      anomalies.push(`High failure rate: ${deliveryFlow.fail_rate_pct}% of sends are failing`);
    }

    return {
      env: {
        engine_enabled: process.env.WHATSAPP_ENGINE_ENABLED !== 'false',
        dry_run_mode: process.env.WHATSAPP_ENGINE_DRY_RUN === 'true',
        test_only_mode: process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true',
        pilot_mode: process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
        test_bypass_send_window: process.env.MARKETING_TEST_BYPASS_SEND_WINDOW === 'true',
      },
      server: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        local_time: now.toISOString(),
        send_window_active: sendWindowActive,
        next_window_start: nextWindow.toISOString(),
      },
      wa: {
        connected: this.whatsAppService.isAnyConnected(),
      },
      test_contacts: {
        count: testContacts.length,
        phones: testContacts.map((t) => t.phone),
      },
      catalog: {
        active_templates: Number(catalogData.active_templates),
        active_campaigns: Number(catalogData.active_campaigns),
        pending_queue_items: Number(catalogData.pending_queue_items),
      },
      queue: queuePattern,
      delivery_flow: deliveryFlow,
      recent_audit_events: recentAuditEvents,
      anomalies,
    };
  }

  async getTestAudienceDiagnostics(): Promise<Record<string, unknown>> {
    const now = new Date();

    // 1. Raw test contacts — every column
    const rawRows: any[] = await this.ds.query(`
      SELECT id, phone, name, is_test_contact, is_whatsapp_valid,
             quality_score::float AS quality_score,
             opt_out, cooldown_until, last_contacted_at, fatigue_score::float AS fatigue_score,
             source, created_at, updated_at
      FROM marketing_audience
      WHERE is_test_contact = true
      ORDER BY created_at DESC
    `);

    // 2. Per-contact filter verdict — reveal exactly which condition fails
    const filterResults = rawRows.map((c: any) => {
      const cooldownActive = c.cooldown_until && new Date(c.cooldown_until) > now;
      const failReasons: string[] = [];
      if (c.opt_out === true || c.opt_out === 'true') failReasons.push('opt_out=true');
      if (c.is_whatsapp_valid === false || c.is_whatsapp_valid === 'false')
        failReasons.push('is_whatsapp_valid=false');
      if (Number(c.quality_score) < 30)
        failReasons.push(`quality_score=${c.quality_score} < 30`);
      if (cooldownActive)
        failReasons.push(`cooldown_until=${c.cooldown_until} (still active)`);
      // Reveal invisible characters or encoding surprises in the phone string
      const phoneHex = Buffer.from(String(c.phone)).toString('hex');
      return {
        phone: c.phone,
        phone_hex: phoneHex,
        phone_length: String(c.phone).length,
        is_whatsapp_valid: c.is_whatsapp_valid,
        quality_score: c.quality_score,
        opt_out: c.opt_out,
        cooldown_until: c.cooldown_until,
        passes: failReasons.length === 0,
        fail_reasons: failReasons,
      };
    });

    // 3. What filterByQuality(30) actually returns right now
    const filteredRows: any[] = await this.ds.query(`
      SELECT phone, quality_score::float, is_whatsapp_valid, opt_out, cooldown_until
      FROM marketing_audience
      WHERE opt_out = false
        AND is_whatsapp_valid = true
        AND quality_score >= 30
        AND (cooldown_until IS NULL OR cooldown_until <= $1)
      ORDER BY quality_score DESC
    `, [now]);

    // 4. Numbers eligibility
    const numbersRows: any[] = await this.ds.query(`
      SELECT id, phone, status, is_active, daily_sent, daily_limit, warmup_level
      FROM whatsapp_numbers
      ORDER BY created_at DESC
    `);
    const safeNumbers = numbersRows.filter(
      (n: any) => n.is_active && n.status === 'ACTIVE' && Number(n.daily_sent) < Number(n.daily_limit),
    );

    // 5. Templates eligibility
    const templatesRows: any[] = await this.ds.query(`
      SELECT id, name, is_active FROM marketing_templates ORDER BY created_at DESC
    `);
    const activeTemplates = templatesRows.filter((t: any) => t.is_active);

    // 6. Current pending queue
    const pendingRows: any[] = await this.ds.query(`
      SELECT id, customer_phone, scheduled_at, status, priority, created_at
      FROM whatsapp_message_queue
      WHERE status = 'pending'
      ORDER BY scheduled_at ASC
      LIMIT 20
    `);

    return {
      timestamp: now.toISOString(),
      raw_test_contacts: rawRows,
      filter_results: filterResults,
      filtered_passed_count: filteredRows.length,
      filtered_passed: filteredRows,
      numbers: {
        total: numbersRows.length,
        safe: safeNumbers.length,
        detail: numbersRows.map((n: any) => ({
          phone: n.phone,
          status: n.status,
          is_active: n.is_active,
          daily_sent: n.daily_sent,
          daily_limit: n.daily_limit,
          is_safe: safeNumbers.some((s: any) => s.id === n.id),
        })),
      },
      templates: {
        total: templatesRows.length,
        active: activeTemplates.length,
        names: activeTemplates.map((t: any) => t.name),
      },
      pending_queue: {
        count: pendingRows.length,
        items: pendingRows,
      },
      verdict:
        filteredRows.length === 0
          ? 'BLOCKED: no contacts pass filterByQuality(30) — see filter_results for exact reasons'
          : safeNumbers.length === 0
          ? 'BLOCKED: audience passes filter but no safe numbers available'
          : activeTemplates.length === 0
          ? 'BLOCKED: audience + numbers OK but no active templates'
          : 'OK: all gates pass — queue should build',
    };
  }

  async getDeliveryFlow(): Promise<DeliveryFlowReport> {
    return this._getDeliveryFlow();
  }

  async seedTestContacts(
    contacts: { phone: string; name?: string }[],
  ): Promise<{ seeded: number }> {
    for (const c of contacts) {
      await this.audienceRepo
        .createQueryBuilder()
        .insert()
        .into(MarketingAudience)
        .values({
          phone: c.phone,
          name: c.name ?? 'Test Contact',
          is_test_contact: true,
          is_whatsapp_valid: true,
          quality_score: 50,
          source: 'TEST',
          opt_out: false,
          cooldown_until: null,
        } as any)
        .orUpdate(
          ['name', 'is_test_contact', 'is_whatsapp_valid', 'quality_score', 'opt_out', 'source', 'cooldown_until'],
          ['phone'],
        )
        .execute();
    }
    return { seeded: contacts.length };
  }

  private async _getDeliveryFlow(): Promise<DeliveryFlowReport> {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const [statusRows, queueStatusRows] = await Promise.all([
      this.logRepo
        .createQueryBuilder('l')
        .select('l.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('l.sent_at >= :since', { since: todayMidnight })
        .groupBy('l.status')
        .getRawMany<{ status: string; count: string }>(),
      this.queueRepo
        .createQueryBuilder('q')
        .select('q.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('q.created_at >= :since', { since: todayMidnight })
        .groupBy('q.status')
        .getRawMany<{ status: string; count: string }>(),
    ]);

    const logCounts: Record<string, number> = {};
    for (const r of statusRows) logCounts[r.status] = parseInt(r.count, 10);

    const queueCounts: Record<string, number> = {};
    for (const r of queueStatusRows) queueCounts[r.status] = parseInt(r.count, 10);

    const sent = logCounts['sent'] ?? 0;
    const delivered = logCounts['delivered'] ?? 0;
    const read = logCounts['read'] ?? 0;
    const replied = logCounts['replied'] ?? 0;
    const failed = logCounts['failed'] ?? 0;
    const total = sent + failed;

    return {
      since: todayMidnight.toISOString(),
      pending: queueCounts['pending'] ?? 0,
      processing: queueCounts['processing'] ?? 0,
      sent,
      delivered,
      read,
      replied,
      failed,
      skipped: queueCounts['skipped'] ?? 0,
      delivery_rate_pct: total > 0 ? Math.round((delivered / total) * 100) : 0,
      read_rate_pct: sent > 0 ? Math.round((read / sent) * 100) : 0,
      reply_rate_pct: sent > 0 ? Math.round((replied / sent) * 100) : 0,
      fail_rate_pct: total > 0 ? Math.round((failed / total) * 100) : 0,
    };
  }

  private async _analyzeQueuePatterns(): Promise<QueuePatternReport> {
    const stuckCutoff = new Date(Date.now() - STUCK_PROCESSING_MS);

    const [pendingItems, stuckCount, retryLoopCount] = await Promise.all([
      this.queueRepo.find({
        where: { status: QueueStatus.PENDING },
        select: ['id', 'customer_phone', 'template_id', 'number_id', 'scheduled_at'],
      }),
      this.queueRepo.count({
        where: { status: QueueStatus.PROCESSING, updated_at: LessThan(stuckCutoff) },
      }),
      this.queueRepo.count({
        where: { status: QueueStatus.FAILED },
      }),
    ]);

    // Retry loops: FAILED items with attempt_count >= 3
    const highAttemptCount = await this.queueRepo
      .createQueryBuilder('q')
      .where('q.status = :s', { s: QueueStatus.FAILED })
      .andWhere('q.attempt_count >= 3')
      .getCount();

    // Duplicate phone detection
    const phoneCounts: Record<string, number> = {};
    for (const item of pendingItems) {
      phoneCounts[item.customer_phone] = (phoneCounts[item.customer_phone] ?? 0) + 1;
    }
    const duplicate_phones = Object.entries(phoneCounts)
      .filter(([, count]) => count > 1)
      .map(([phone, count]) => ({ phone, count }));

    let outside_window = 0;
    const timing_by_hour: Record<string, number> = {};
    for (const item of pendingItems) {
      const h = item.scheduled_at.getHours();
      const m = item.scheduled_at.getMinutes();
      const totalMin = h * 60 + m;
      const hourKey = String(h).padStart(2, '0') + ':00';
      timing_by_hour[hourKey] = (timing_by_hour[hourKey] ?? 0) + 1;
      if (totalMin < WINDOW_START || totalMin > WINDOW_END) outside_window++;
    }

    const templateCounts: Record<string, number> = {};
    for (const item of pendingItems) {
      const key = item.template_id ?? 'none';
      templateCounts[key] = (templateCounts[key] ?? 0) + 1;
    }
    const template_distribution = Object.entries(templateCounts)
      .map(([template_id, count]) => ({ template_id: template_id === 'none' ? null : template_id, count }))
      .sort((a, b) => b.count - a.count);

    const numberCounts: Record<string, number> = {};
    for (const item of pendingItems) {
      const key = item.number_id ?? 'none';
      numberCounts[key] = (numberCounts[key] ?? 0) + 1;
    }
    const number_distribution = Object.entries(numberCounts)
      .map(([number_id, count]) => ({ number_id: number_id === 'none' ? null : number_id, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total_pending: pendingItems.length,
      stuck_processing: stuckCount,
      retry_loops: highAttemptCount,
      duplicate_phones,
      outside_window,
      template_distribution,
      number_distribution,
      timing_by_hour,
    };
  }

  private async _getRecentAuditEvents(): Promise<
    { event: string; reason: string | null; created_at: string }[]
  > {
    try {
      const rows: { event: string; reason: string | null; created_at: Date }[] =
        await this.ds.query(
          `SELECT event, reason, created_at
           FROM engine_audit_logs
           ORDER BY created_at DESC
           LIMIT 20`,
        );
      return rows.map((r) => ({
        event: r.event,
        reason: r.reason,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
    } catch {
      return [];
    }
  }
}

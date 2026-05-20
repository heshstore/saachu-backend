import { Injectable } from '@nestjs/common';
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
    const [queuePattern, deliveryFlow, testContacts, recentAuditEvents] = await Promise.all([
      this._analyzeQueuePatterns(),
      this._getDeliveryFlow(),
      this.audienceRepo.find({ where: { is_test_contact: true }, select: ['phone'] }),
      this._getRecentAuditEvents(),
    ]);

    const now = new Date();
    const totalMinutes = now.getHours() * 60 + now.getMinutes();
    const sendWindowActive = totalMinutes >= WINDOW_START && totalMinutes <= WINDOW_END;
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
      queue: queuePattern,
      delivery_flow: deliveryFlow,
      recent_audit_events: recentAuditEvents,
      anomalies,
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
        } as any)
        .orUpdate(['name', 'is_test_contact'], ['phone'])
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

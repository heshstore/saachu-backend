import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsappReply } from '../entities/whatsapp-reply.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { PilotDailyMetrics } from '../entities/pilot-daily-metrics.entity';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { QueueStatus, CampaignStatus } from '../entities/enums';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { getActiveLimits } from '../shared/number-limits';

// ── Thresholds ────────────────────────────────────────────────────────────────
const FAILURE_RATE_CRITICAL_PCT   = 20;  // fail% above this → CRITICAL alert + YELLOW
const DELIVERY_RATE_LOW_PCT       = 50;  // delivery% below this → WARN alert (min 5 sends)
const QUEUE_STALE_MINUTES         = 30;  // pending item due but unprocessed → WARN
const PROCESSING_STUCK_MINUTES    = 5;   // processing row not released → FAIL
const REPLY_SILENCE_HOURS         = 24;  // no replies after N sends today → WARN
const REPLY_SILENCE_MIN_SENDS     = 5;   // only apply silence alert after this many sends

export type PilotStatus = 'GREEN' | 'YELLOW' | 'RED';
export type CheckStatus = 'OK' | 'WARN' | 'FAIL';
export type AlertLevel  = 'WARN' | 'CRITICAL';

export interface HealthCheck {
  name:   string;
  status: CheckStatus;
  detail: string;
}

export interface PilotAlert {
  level:   AlertLevel;
  code:    string;
  message: string;
}

export interface PilotDashboard {
  // Today's volume
  sent_today:      number;
  delivered_today: number;
  read_today:      number;
  replied_today:   number;
  failed_today:    number;
  skipped_today:   number;
  // Rates (cumulative — delivered includes read, sent includes delivered)
  delivery_rate_pct: number;
  read_rate_pct:     number;
  reply_rate_pct:    number;
  failure_rate_pct:  number;
  // Sender health
  active_numbers:    number;
  connected_numbers: number;
  numbers_at_cap:    number;
  // Queue
  queue_backlog:     number;
  queue_processing:  number;
  queue_stuck:       number;
  // Status
  pilot_status:   PilotStatus;
  status_reasons: string[];
  alerts:         PilotAlert[];
  health_checks:  HealthCheck[];
  as_of:          string;
}

@Injectable()
export class PilotMonitoringService {
  private readonly logger = new Logger(PilotMonitoringService.name);

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappMessageQueue)
    private readonly queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(WhatsappReply)
    private readonly replyRepo: Repository<WhatsappReply>,
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(PilotDailyMetrics)
    private readonly metricsRepo: Repository<PilotDailyMetrics>,
    @InjectRepository(MarketingCampaign)
    private readonly campaignRepo: Repository<MarketingCampaign>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly whatsAppService: MarketingWhatsAppService,
  ) {}

  // ── Snapshot at 23:55 IST (18:25 UTC) daily ──────────────────────────────
  @Cron('25 18 * * *')
  async snapshotDailyMetrics(): Promise<void> {
    this.logger.log('[PILOT_SNAPSHOT] Daily metrics snapshot starting');
    try {
      const snap = await this._computeTodayStats();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await this.metricsRepo.upsert({
        date:              today,
        sent_count:        snap.sent,
        delivered_count:   snap.delivered,
        read_count:        snap.read,
        replied_count:     snap.replied,
        failed_count:      snap.failed,
        skipped_count:     snap.skipped,
        delivery_rate_pct: snap.delivery_rate,
        read_rate_pct:     snap.read_rate,
        reply_rate_pct:    snap.reply_rate,
        failure_rate_pct:  snap.failure_rate,
        active_numbers:    snap.active_numbers,
        connected_numbers: snap.connected_numbers,
        queue_backlog:     snap.queue_backlog,
      }, ['date']);
      this.logger.log(`[PILOT_SNAPSHOT] Done — sent=${snap.sent} delivered=${snap.delivered} read=${snap.read} replied=${snap.replied}`);
    } catch (err: any) {
      this.logger.error(`[PILOT_SNAPSHOT] Failed: ${err?.message}`);
    }
  }

  // ── Main dashboard ────────────────────────────────────────────────────────
  async getDashboard(): Promise<PilotDashboard> {
    const [stats, numbers, queueInfo] = await Promise.all([
      this._computeTodayStats(),
      this.numberRepo.find(),
      this._computeQueueInfo(),
    ]);

    const health = await this._runHealthChecks(stats, numbers, queueInfo);
    const alerts = this._deriveAlerts(stats, numbers, queueInfo, health);
    const { status, reasons } = this._deriveStatus(health, alerts);

    this.logger.log(
      `[PILOT_DASHBOARD] status=${status} sent=${stats.sent} delivered=${stats.delivered} ` +
      `read=${stats.read} replied=${stats.replied} failed=${stats.failed} ` +
      `connected=${stats.connected_numbers} backlog=${queueInfo.backlog} ` +
      `alerts=${alerts.length}`,
    );

    return {
      sent_today:        stats.sent,
      delivered_today:   stats.delivered,
      read_today:        stats.read,
      replied_today:     stats.replied,
      failed_today:      stats.failed,
      skipped_today:     stats.skipped,
      delivery_rate_pct: stats.delivery_rate,
      read_rate_pct:     stats.read_rate,
      reply_rate_pct:    stats.reply_rate,
      failure_rate_pct:  stats.failure_rate,
      active_numbers:    stats.active_numbers,
      connected_numbers: stats.connected_numbers,
      numbers_at_cap:    stats.numbers_at_cap,
      queue_backlog:     queueInfo.backlog,
      queue_processing:  queueInfo.processing,
      queue_stuck:       queueInfo.stuck,
      pilot_status:      status,
      status_reasons:    reasons,
      alerts,
      health_checks:     health,
      as_of:             new Date().toISOString(),
    };
  }

  // ── Historical daily metrics (last N days) ────────────────────────────────
  async getDailyMetrics(days = 7): Promise<PilotDailyMetrics[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    return this.metricsRepo
      .createQueryBuilder('m')
      .where('m.date >= :since', { since })
      .orderBy('m.date', 'DESC')
      .getMany();
  }

  // ── Internal: today's send stats ─────────────────────────────────────────
  private async _computeTodayStats() {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const [sentRows, repliesRows, allNumbers] = await Promise.all([
      this.logRepo
        .createQueryBuilder('l')
        .select('l.status', 'status')
        .addSelect('COUNT(*)', 'cnt')
        .where('l.sent_at >= :mid', { mid: todayMidnight })
        .groupBy('l.status')
        .getRawMany<{ status: string; cnt: string }>(),
      this.replyRepo
        .createQueryBuilder('r')
        .where('r.received_at >= :mid', { mid: todayMidnight })
        .getCount(),
      this.numberRepo.find(),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of sentRows) byStatus[r.status] = parseInt(r.cnt, 10);

    const sent      = (byStatus[QueueStatus.SENT]      ?? 0)
                    + (byStatus[QueueStatus.DELIVERED]  ?? 0)
                    + (byStatus[QueueStatus.READ]        ?? 0)
                    + (byStatus[QueueStatus.REPLIED]     ?? 0);
    const delivered = (byStatus[QueueStatus.DELIVERED]  ?? 0)
                    + (byStatus[QueueStatus.READ]        ?? 0)
                    + (byStatus[QueueStatus.REPLIED]     ?? 0);
    const read      = (byStatus[QueueStatus.READ]        ?? 0)
                    + (byStatus[QueueStatus.REPLIED]     ?? 0);
    const replied   =  byStatus[QueueStatus.REPLIED]     ?? 0;
    const failed    =  byStatus[QueueStatus.FAILED]      ?? 0;
    const skipped   =  byStatus[QueueStatus.SKIPPED]     ?? 0;
    const total_attempted = sent + failed;

    const pct = (n: number, d: number) =>
      d > 0 ? Math.round((n / d) * 10000) / 100 : 0;

    const connected_numbers = allNumbers.filter(n => this.whatsAppService.isConnected(n.id)).length;
    const active_numbers    = allNumbers.filter(n => n.is_active).length;

    // Numbers at cap: daily_sent >= effective pilot cap
    const numbers_at_cap = allNumbers.filter(n => {
      const { daily: pilotDaily } = this._pilotCap(n.warmup_level);
      return n.daily_sent >= pilotDaily;
    }).length;

    const queue_backlog = await this.queueRepo
      .createQueryBuilder('q')
      .where('q.status = :s', { s: QueueStatus.PENDING })
      .andWhere('q.scheduled_at <= :now', { now: new Date() })
      .getCount();

    return {
      sent, delivered, read, replied, failed, skipped,
      delivery_rate: pct(delivered, sent),
      read_rate:     pct(read, sent),
      reply_rate:    pct(replied, sent),
      failure_rate:  pct(failed, total_attempted),
      replies_today: repliesRows,
      active_numbers, connected_numbers, numbers_at_cap,
      queue_backlog,
    };
  }

  // ── Internal: queue state ─────────────────────────────────────────────────
  private async _computeQueueInfo() {
    const stuckCutoff = new Date(Date.now() - PROCESSING_STUCK_MINUTES * 60_000);
    const [backlog, processing, stuck] = await Promise.all([
      this.queueRepo.createQueryBuilder('q')
        .where('q.status = :s', { s: QueueStatus.PENDING })
        .andWhere('q.scheduled_at <= :now', { now: new Date() })
        .getCount(),
      this.queueRepo.count({ where: { status: QueueStatus.PROCESSING } }),
      this.queueRepo.createQueryBuilder('q')
        .where('q.status = :s', { s: QueueStatus.PROCESSING })
        .andWhere('q.updated_at < :cut', { cut: stuckCutoff })
        .getCount(),
    ]);
    return { backlog, processing, stuck };
  }

  // ── Internal: health checks ───────────────────────────────────────────────
  private async _runHealthChecks(
    stats: Awaited<ReturnType<typeof this._computeTodayStats>>,
    numbers: WhatsappNumber[],
    qi: { backlog: number; processing: number; stuck: number },
  ): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];

    // 1. At least one connected number
    if (stats.connected_numbers > 0) {
      checks.push({ name: 'SENDER_CONNECTED', status: 'OK', detail: `${stats.connected_numbers} number(s) connected` });
    } else {
      checks.push({ name: 'SENDER_CONNECTED', status: 'FAIL', detail: 'No connected WhatsApp numbers — cannot send' });
    }

    // 2. Stuck processing rows
    if (qi.stuck === 0) {
      checks.push({ name: 'QUEUE_NOT_STUCK', status: 'OK', detail: `No processing rows older than ${PROCESSING_STUCK_MINUTES} min` });
    } else {
      checks.push({ name: 'QUEUE_NOT_STUCK', status: 'FAIL', detail: `${qi.stuck} queue row(s) stuck in PROCESSING for >${PROCESSING_STUCK_MINUTES} min` });
    }

    // 3. Failure rate
    const total_attempted = stats.sent + stats.failed;
    if (total_attempted < 3) {
      checks.push({ name: 'FAILURE_RATE', status: 'OK', detail: `Too few sends today (${total_attempted}) to evaluate` });
    } else if (stats.failure_rate <= FAILURE_RATE_CRITICAL_PCT) {
      checks.push({ name: 'FAILURE_RATE', status: 'OK', detail: `${stats.failure_rate}% failures (threshold: ${FAILURE_RATE_CRITICAL_PCT}%)` });
    } else {
      checks.push({ name: 'FAILURE_RATE', status: 'WARN', detail: `${stats.failure_rate}% failures exceeds ${FAILURE_RATE_CRITICAL_PCT}% threshold` });
    }

    // 4. Sender daily capacity
    const numberIds = numbers.filter(n => n.is_active).map(n => n.id);
    const hasSenderCapacity = numberIds.some(id => {
      if (!this.whatsAppService.isConnected(id)) return false;
      const n = numbers.find(x => x.id === id);
      if (!n) return false;
      const { daily } = this._pilotCap(n.warmup_level);
      return n.daily_sent < daily;
    });
    if (hasSenderCapacity) {
      checks.push({ name: 'SENDER_CAPACITY', status: 'OK', detail: 'At least one number has remaining daily capacity' });
    } else {
      checks.push({ name: 'SENDER_CAPACITY', status: 'WARN', detail: 'All active numbers are at daily cap or disconnected' });
    }

    // 5. Inbox active (only meaningful if enough sends today)
    if (stats.sent >= REPLY_SILENCE_MIN_SENDS) {
      const cutoff = new Date(Date.now() - REPLY_SILENCE_HOURS * 3_600_000);
      const recentReply = await this.replyRepo
        .createQueryBuilder('r')
        .where('r.received_at >= :cut', { cut: cutoff })
        .getCount();
      if (recentReply > 0) {
        checks.push({ name: 'INBOX_ACTIVE', status: 'OK', detail: `${recentReply} reply/replies received in last ${REPLY_SILENCE_HOURS}h` });
      } else {
        checks.push({ name: 'INBOX_ACTIVE', status: 'WARN', detail: `No replies received in last ${REPLY_SILENCE_HOURS}h despite ${stats.sent} sends today` });
      }
    } else {
      checks.push({ name: 'INBOX_ACTIVE', status: 'OK', detail: `Not enough sends today (${stats.sent}) to evaluate inbox` });
    }

    // 6. Running campaigns have active queue
    const runningCampaigns = await this.campaignRepo.find({
      where: { status: CampaignStatus.RUNNING },
    });
    const stalledCampaigns: string[] = [];
    for (const c of runningCampaigns) {
      const active = await this.queueRepo
        .createQueryBuilder('q')
        .where('q.campaign_id = :id', { id: c.id })
        .andWhere('q.status IN (:...ss)', { ss: [QueueStatus.PENDING, QueueStatus.PROCESSING, QueueStatus.SENT, QueueStatus.DELIVERED, QueueStatus.READ] })
        .getCount();
      if (active === 0) stalledCampaigns.push(c.campaign_name);
    }
    if (stalledCampaigns.length === 0) {
      checks.push({ name: 'CAMPAIGN_QUEUE_HEALTH', status: 'OK', detail: runningCampaigns.length ? `All ${runningCampaigns.length} running campaign(s) have active queue rows` : 'No running campaigns' });
    } else {
      checks.push({ name: 'CAMPAIGN_QUEUE_HEALTH', status: 'WARN', detail: `Campaign(s) running but have no pending/sent rows: ${stalledCampaigns.join(', ')}` });
    }

    return checks;
  }

  // ── Internal: derive alerts from stats + checks ───────────────────────────
  private _deriveAlerts(
    stats: Awaited<ReturnType<typeof this._computeTodayStats>>,
    numbers: WhatsappNumber[],
    qi: { backlog: number; processing: number; stuck: number },
    checks: HealthCheck[],
  ): PilotAlert[] {
    const alerts: PilotAlert[] = [];
    const now = new Date();

    // Queue backlog stale (during send window — rough check based on server TZ hours)
    const hour = now.getHours(); // IST from process TZ
    const inWindow = hour >= 10 && hour < 18;
    if (qi.backlog > 0 && inWindow) {
      // We can only alert if the backlog has been sitting — a proxy is backlog > 0 during window
      alerts.push({
        level: 'WARN',
        code: 'QUEUE_PENDING_STALE',
        message: `${qi.backlog} due queue item(s) not yet processed during send window`,
      });
    }

    // All numbers at cap / disconnected
    const hasCapacity = numbers.filter(n => n.is_active).some(n => {
      if (!this.whatsAppService.isConnected(n.id)) return false;
      const { daily } = this._pilotCap(n.warmup_level);
      return n.daily_sent < daily;
    });
    if (!hasCapacity && stats.active_numbers > 0) {
      alerts.push({
        level: 'CRITICAL',
        code: 'NO_SENDER_CAPACITY',
        message: 'All active numbers are at daily cap or disconnected — no sends possible',
      });
    }

    // Low delivery rate (only meaningful with enough data)
    if (stats.sent >= 5 && stats.delivery_rate < DELIVERY_RATE_LOW_PCT) {
      alerts.push({
        level: 'WARN',
        code: 'LOW_DELIVERY_RATE',
        message: `Delivery rate ${stats.delivery_rate}% is below ${DELIVERY_RATE_LOW_PCT}% threshold (${stats.sent} messages sent)`,
      });
    }

    // High failure rate
    const total_attempted = stats.sent + stats.failed;
    if (total_attempted >= 3 && stats.failure_rate > FAILURE_RATE_CRITICAL_PCT) {
      alerts.push({
        level: 'CRITICAL',
        code: 'HIGH_FAILURE_RATE',
        message: `Failure rate ${stats.failure_rate}% exceeds ${FAILURE_RATE_CRITICAL_PCT}% threshold (${stats.failed} failed of ${total_attempted})`,
      });
    }

    // Reply pipeline silent
    if (stats.sent >= REPLY_SILENCE_MIN_SENDS && stats.replies_today === 0) {
      alerts.push({
        level: 'WARN',
        code: 'REPLY_PIPELINE_SILENT',
        message: `No replies received today despite ${stats.sent} sends — check inbox bridge`,
      });
    }

    // Stuck queue
    if (qi.stuck > 0) {
      alerts.push({
        level: 'CRITICAL',
        code: 'QUEUE_STUCK',
        message: `${qi.stuck} queue row(s) stuck in PROCESSING for >${PROCESSING_STUCK_MINUTES} min — sender may be deadlocked`,
      });
    }

    return alerts;
  }

  // ── Internal: GREEN / YELLOW / RED ───────────────────────────────────────
  private _deriveStatus(
    checks: HealthCheck[],
    alerts: PilotAlert[],
  ): { status: PilotStatus; reasons: string[] } {
    const reasons: string[] = [];

    const failChecks = checks.filter(c => c.status === 'FAIL');
    const critAlerts = alerts.filter(a => a.level === 'CRITICAL');
    const warnChecks = checks.filter(c => c.status === 'WARN');
    const warnAlerts = alerts.filter(a => a.level === 'WARN');

    if (failChecks.length > 0 || critAlerts.length > 0) {
      for (const c of failChecks)  reasons.push(`[FAIL] ${c.name}: ${c.detail}`);
      for (const a of critAlerts)  reasons.push(`[CRITICAL] ${a.code}: ${a.message}`);
      return { status: 'RED', reasons };
    }

    if (warnChecks.length > 0 || warnAlerts.length > 0) {
      for (const c of warnChecks)  reasons.push(`[WARN] ${c.name}: ${c.detail}`);
      for (const a of warnAlerts)  reasons.push(`[WARN] ${a.code}: ${a.message}`);
      return { status: 'YELLOW', reasons };
    }

    return { status: 'GREEN', reasons: ['All health checks passing'] };
  }

  private _pilotCap(level: number): { daily: number } {
    return getActiveLimits(level);
  }
}

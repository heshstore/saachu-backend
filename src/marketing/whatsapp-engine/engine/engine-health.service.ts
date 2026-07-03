import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsAppNumberStatus, QueueStatus } from '../entities/enums';
import { RiskAiService } from '../ai/risk-ai.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { EngineSettingsService } from './engine-settings.service';

export interface NumberProgress {
  id: string;
  phone: string;
  name: string;
  daily_sent: number;
  daily_limit: number;
  wa_state: string;
  connected: boolean;
}

export interface RecentDisconnect {
  number_id: string;
  phone: string | null;
  timestamp: string;
}

export interface EngineHealthReport {
  engine_enabled: boolean;
  dry_run_mode: boolean;
  pilot_mode: boolean;
  test_only_mode: boolean;
  max_daily_audience: string;
  wa_connected: boolean;
  send_window_active: boolean;
  queue_pending: number;
  queue_processing: number;
  queue_deferred: number;
  ai_generated_today: number;
  auto_ai_mode: boolean;
  standby_reason: string | null;
  sent_last_hour: number;
  failed_last_hour: number;
  active_numbers: number;
  paused_numbers: number;
  risky_numbers: number;
  risk_alerts: { number_id: string; phone: string; risk_score: number }[];
  wa_state_breakdown: Record<string, number>;
  number_progress: NumberProgress[];
  recent_disconnects: RecentDisconnect[];
  checked_at: string;
}

@Injectable()
export class EngineHealthService {
  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappMessageQueue)
    private readonly queueRepo: Repository<WhatsappMessageQueue>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly riskAi: RiskAiService,
    private readonly timingAi: TimingAiService,
    private readonly whatsAppService: MarketingWhatsAppService,
    private readonly engineSettings: EngineSettingsService,
  ) {}

  async getHealth(): Promise<EngineHealthReport> {
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const now = new Date();

    const [
      queue_pending,
      queue_processing,
      queue_deferred,
      sent_last_hour,
      failed_last_hour,
      active_numbers,
      paused_numbers,
      riskyRows,
      auto_ai_mode,
      allNumbers,
    ] = await Promise.all([
      this.queueRepo.count({ where: { status: QueueStatus.PENDING } }),
      this.queueRepo.count({ where: { status: QueueStatus.PROCESSING } }),
      this.queueRepo
        .createQueryBuilder('q')
        .where('q.status = :s', { s: QueueStatus.PENDING })
        .andWhere('q.scheduled_at > :now', { now })
        .getCount(),
      this.logRepo
        .createQueryBuilder('l')
        .where('l.status = :s', { s: QueueStatus.SENT })
        .andWhere('l.sent_at >= :h', { h: oneHourAgo })
        .getCount(),
      this.logRepo
        .createQueryBuilder('l')
        .where('l.status = :s', { s: QueueStatus.FAILED })
        .andWhere('l.sent_at >= :h', { h: oneHourAgo })
        .getCount(),
      this.numberRepo.count({
        where: { is_active: true, status: WhatsAppNumberStatus.ACTIVE },
      }),
      this.numberRepo.count({ where: { is_active: false } }),
      this.riskAi.getRiskyNumbers(),
      this.engineSettings.getAutoAiMode(),
      this.numberRepo.find({ order: { created_at: 'DESC' } }),
    ]);

    // JSONB check for AI-generated messages — requires raw SQL
    const aiGenRows: { count: string }[] = await this.ds.query(
      `SELECT COUNT(*)::text AS count
       FROM whatsapp_message_queue
       WHERE message_payload->>'generated_message' IS NOT NULL
         AND created_at >= $1`,
      [todayMidnight],
    );
    const ai_generated_today = parseInt(aiGenRows[0]?.count ?? '0', 10);

    // Recent disconnect events from audit log (empty if none have been emitted yet)
    type DisconnectRow = {
      number_id: string;
      phone: string | null;
      created_at: string;
    };
    const disconnectRows: DisconnectRow[] = await this.ds
      .query(
        `SELECT e.number_id, n.phone, e.created_at
       FROM engine_audit_logs e
       LEFT JOIN whatsapp_numbers n ON n.id::text = e.number_id
       WHERE e.event = 'NUMBER_DISCONNECTED'
       ORDER BY e.created_at DESC
       LIMIT 5`,
      )
      .catch(() => []);

    const recent_disconnects: RecentDisconnect[] = disconnectRows.map((r) => ({
      number_id: r.number_id,
      phone: r.phone ?? null,
      timestamp: r.created_at,
    }));

    // Per-number progress — reuses already-loaded allNumbers + live in-memory WA state
    const number_progress: NumberProgress[] = allNumbers.map((n) => ({
      id: n.id,
      phone: n.phone,
      name: n.name,
      daily_sent: n.daily_sent,
      daily_limit: n.daily_limit,
      wa_state: this.whatsAppService.getNumberWaStatus(n.id).waState,
      connected: this.whatsAppService.isConnected(n.id),
    }));

    const engine_enabled = process.env.WHATSAPP_ENGINE_ENABLED !== 'false';
    const wa_connected = this.whatsAppService.isAnyConnected();
    const send_window_active = this.timingAi.isWithinSendWindow();

    const standby_reason = this._computeStandbyReason({
      engine_enabled,
      wa_connected,
      send_window_active,
      queue_pending,
      queue_deferred,
    });

    return {
      engine_enabled,
      dry_run_mode: process.env.WHATSAPP_ENGINE_DRY_RUN === 'true',
      pilot_mode: process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
      test_only_mode: process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true',
      max_daily_audience:
        process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE ?? 'unlimited',
      wa_connected,
      wa_state_breakdown: this.whatsAppService.getStateBreakdown(),
      send_window_active,
      queue_pending,
      queue_processing,
      queue_deferred,
      ai_generated_today,
      auto_ai_mode,
      standby_reason,
      sent_last_hour,
      failed_last_hour,
      active_numbers,
      paused_numbers,
      risky_numbers: riskyRows.length,
      risk_alerts: riskyRows.map((n) => ({
        number_id: n.id,
        phone: n.phone,
        risk_score: Number(n.risk_score),
      })),
      number_progress,
      recent_disconnects,
      checked_at: new Date().toISOString(),
    };
  }

  private _computeStandbyReason(flags: {
    engine_enabled: boolean;
    wa_connected: boolean;
    send_window_active: boolean;
    queue_pending: number;
    queue_deferred: number;
  }): string | null {
    if (!flags.engine_enabled) return 'Engine disabled';
    if (!flags.wa_connected) return 'No connected WhatsApp numbers';
    if (!flags.send_window_active) return 'Outside sending window';
    if (flags.queue_pending === 0 && flags.queue_deferred === 0)
      return 'Queue empty';
    return null;
  }
}

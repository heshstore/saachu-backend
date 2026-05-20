import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { WhatsAppNumberStatus, QueueStatus } from '../entities/enums';
import { RiskAiService } from '../ai/risk-ai.service';
import { TimingAiService } from '../ai/timing-ai.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';

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
  sent_last_hour: number;
  failed_last_hour: number;
  active_numbers: number;
  paused_numbers: number;
  risky_numbers: number;
  risk_alerts: { number_id: string; phone: string; risk_score: number }[];
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
    private readonly riskAi: RiskAiService,
    private readonly timingAi: TimingAiService,
    private readonly whatsAppService: MarketingWhatsAppService,
  ) {}

  async getHealth(): Promise<EngineHealthReport> {
    const oneHourAgo = new Date(Date.now() - 3_600_000);

    const [
      queue_pending,
      queue_processing,
      sent_last_hour,
      failed_last_hour,
      active_numbers,
      paused_numbers,
      riskyRows,
    ] = await Promise.all([
      this.queueRepo.count({ where: { status: QueueStatus.PENDING } }),
      this.queueRepo.count({ where: { status: QueueStatus.PROCESSING } }),
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
      this.numberRepo.count({ where: { is_active: true, status: WhatsAppNumberStatus.ACTIVE } }),
      this.numberRepo.count({ where: { is_active: false } }),
      this.riskAi.getRiskyNumbers(),
    ]);

    return {
      engine_enabled:     process.env.WHATSAPP_ENGINE_ENABLED !== 'false',
      dry_run_mode:       process.env.WHATSAPP_ENGINE_DRY_RUN === 'true',
      pilot_mode:         process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true',
      test_only_mode:     process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true',
      max_daily_audience: process.env.WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE ?? 'unlimited',
      wa_connected: this.whatsAppService.isAnyConnected(),
      send_window_active: this.timingAi.isWithinSendWindow(),
      queue_pending,
      queue_processing,
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
      checked_at: new Date().toISOString(),
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { EngineAuditService, AuditEvent } from './engine-audit.service';
import { PROMOTION_RULES, getReleaseAllowance } from '../shared/number-limits';
import {
  computeHealthMetrics,
  countHealthyDayStreak,
  countsFromStatusMap,
  isHealthyDay,
  type DailyHealthRow,
  type HealthMetrics,
} from '../shared/warmup-health';

@Injectable()
export class WarmupProgressionService {
  private readonly logger = new Logger(WarmupProgressionService.name);

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly auditService: EngineAuditService,
  ) {}

  /** Evaluate promotions daily after audience calibration (7:15 AM IST). */
  @Cron('15 7 * * *', { timeZone: 'Asia/Kolkata' })
  async evaluatePromotionsCron(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;
    await this.evaluateAllPromotions('cron_0715_ist');
  }

  async evaluateAllPromotions(source = 'manual'): Promise<{ evaluated: number; promoted: number }> {
    const numbers = await this.numberRepo.find({ where: { is_active: true } });
    let promoted = 0;
    for (const number of numbers) {
      const result = await this.evaluateNumberPromotion(number, source);
      if (result.promoted) promoted++;
    }
    return { evaluated: numbers.length, promoted };
  }

  async getHealthMetrics(numberId: string): Promise<HealthMetrics> {
    const counts = await this._fetchWindowCounts(numberId);
    return computeHealthMetrics(counts);
  }

  async getDailyHealthRows(numberId: string, days = 14): Promise<DailyHealthRow[]> {
    type Row = {
      day: string;
      sent: string;
      delivered: string;
      read: string;
      replied: string;
      failed: string;
    };

    const rows: Row[] = await this.ds.query(
      `SELECT
         TO_CHAR((l.sent_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
         COUNT(*) FILTER (WHERE l.status = 'sent')      AS sent,
         COUNT(*) FILTER (WHERE l.status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE l.status = 'read')      AS read,
         COUNT(*) FILTER (WHERE l.status = 'replied')   AS replied,
         COUNT(*) FILTER (WHERE l.status = 'failed')    AS failed
       FROM whatsapp_message_logs l
       WHERE l.number_id = $1
         AND l.sent_at >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
       GROUP BY 1
       ORDER BY 1 DESC`,
      [numberId, days],
    );

    return rows.map((r) => {
      const base = {
        date: r.day,
        sent:      parseInt(r.sent, 10),
        delivered: parseInt(r.delivered, 10),
        read:      parseInt(r.read, 10),
        replied:   parseInt(r.replied, 10),
        failed:    parseInt(r.failed, 10),
      };
      return { ...base, isHealthyDay: isHealthyDay(base) };
    });
  }

  private async evaluateNumberPromotion(
    number: WhatsappNumber,
    source: string,
  ): Promise<{ promoted: boolean; fromLevel: number; toLevel: number }> {
    const fromLevel = number.warmup_level;
    if (fromLevel >= 4) {
      return { promoted: false, fromLevel, toLevel: fromLevel };
    }

    const metrics = await this.getHealthMetrics(number.id);
    const dailyRows = await this.getDailyHealthRows(number.id, PROMOTION_RULES.healthyDaysRequired + 2);
    const streak = countHealthyDayStreak(dailyRows);

    const eligible =
      metrics.isHealthy &&
      streak >= PROMOTION_RULES.healthyDaysRequired;

    if (!eligible) {
      this.logger.log(
        `[WARMUP_HOLD] number=${number.phone} level=L${fromLevel} ` +
        `healthy=${metrics.isHealthy} streak=${streak}/${PROMOTION_RULES.healthyDaysRequired} ` +
        `score=${metrics.healthScore}`,
      );
      return { promoted: false, fromLevel, toLevel: fromLevel };
    }

    const toLevel = Math.min(4, fromLevel + 1);
    const releaseAllowance = getReleaseAllowance(toLevel);
    await this.numberRepo.update(number.id, {
      warmup_level: toLevel,
      daily_limit: releaseAllowance,
    });

    await this.auditService.log({
      event: AuditEvent.WARMUP_PROMOTED,
      number_id: number.id,
      reason: `Promoted L${fromLevel} → L${toLevel} after ${streak} healthy days (7d score=${metrics.healthScore})`,
      metadata: {
        source,
        from_level: fromLevel,
        to_level: toLevel,
        healthy_streak: streak,
        health_score: metrics.healthScore,
        delivery_rate_pct: metrics.deliveryRatePct,
        read_rate_pct: metrics.readRatePct,
        reply_rate_pct: metrics.replyRatePct,
        fail_rate_pct: metrics.failRatePct,
        release_allowance: releaseAllowance,
      },
    });

    this.logger.log(
      `[WARMUP_PROMOTED] number=${number.phone} L${fromLevel}→L${toLevel} ` +
      `streak=${streak} score=${metrics.healthScore} source=${source}`,
    );
    return { promoted: true, fromLevel, toLevel };
  }

  private async _fetchWindowCounts(numberId: string) {
    type Row = { status: string; count: string };
    const rows: Row[] = await this.ds.query(
      `SELECT l.status, COUNT(*)::text AS count
       FROM whatsapp_message_logs l
       WHERE l.number_id = $1
         AND l.sent_at >= NOW() - INTERVAL '7 days'
       GROUP BY l.status`,
      [numberId],
    );
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = parseInt(r.count, 10);
    return countsFromStatusMap(map);
  }
}

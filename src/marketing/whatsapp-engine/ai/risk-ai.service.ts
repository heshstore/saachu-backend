import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsAppNumberStatus } from '../entities/enums';

@Injectable()
export class RiskAiService {
  private readonly logger = new Logger(RiskAiService.name);

  constructor(
    @InjectRepository(WhatsappNumber)
    private readonly numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async calculateRiskScore(numberId: string): Promise<number> {
    const number = await this.numberRepo.findOne({ where: { id: numberId } });
    if (!number) return 0;

    // Immediately return 100 for banned numbers
    if (number.status === WhatsAppNumberStatus.BANNED) return 100;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const rows: { status: string; count: string }[] = await this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.number_id = :numberId', { numberId })
      .andWhere('l.sent_at >= :sevenDaysAgo', { sevenDaysAgo })
      .groupBy('l.status')
      .getRawMany();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const n = parseInt(row.count, 10);
      counts[row.status] = n;
      total += n;
    }

    let score = 0;

    if (total > 0) {
      const failed = counts['failed'] ?? 0;
      const replied = counts['replied'] ?? 0;
      const failRate = (failed / total) * 100;
      const replyRate = (replied / total) * 100;

      if (failRate > 30) {
        score += 40;
      } else if (failRate > 15) {
        score += 20;
      }

      if (replyRate < 2 && total > 20) {
        score += 20;
      }
    }

    // daily_sent vs daily_limit
    if (number.daily_limit > 0 && (number.daily_sent / number.daily_limit) >= 0.9) {
      score += 15;
    }

    return Math.min(100, score);
  }

  async isNumberSafe(numberId: string): Promise<boolean> {
    const score = await this.calculateRiskScore(numberId);
    return score < 60;
  }

  async shouldPauseNumber(numberId: string): Promise<boolean> {
    const score = await this.calculateRiskScore(numberId);

    if (score >= 80) {
      await this.numberRepo.update(numberId, {
        status: WhatsAppNumberStatus.INACTIVE,
        risk_score: score,
      });
      this.logger.warn(`[RiskAI] Paused number ${numberId} with risk score ${score}`);
      return true;
    }

    await this.numberRepo.update(numberId, { risk_score: score });
    return false;
  }

  async getRiskyNumbers(): Promise<WhatsappNumber[]> {
    return this.numberRepo
      .createQueryBuilder('n')
      .where('n.risk_score >= 60')
      .andWhere('n.is_active = true')
      .getMany();
  }

  // Detect short-burst block pattern: >30% failure rate in last hour with at least 5 sends
  async checkHourlyBlockDetection(numberId: string): Promise<boolean> {
    const number = await this.numberRepo.findOne({ where: { id: numberId } });
    if (!number || number.status === WhatsAppNumberStatus.BANNED) return false;

    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const rows: { status: string; count: string }[] = await this.logRepo
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('l.number_id = :numberId', { numberId })
      .andWhere('l.sent_at >= :oneHourAgo', { oneHourAgo })
      .groupBy('l.status')
      .getRawMany();

    let total = 0;
    let failed = 0;
    for (const row of rows) {
      const n = parseInt(row.count, 10);
      total += n;
      if (row.status === 'failed') failed = n;
    }

    if (total < 5) return false;

    const hourlyFailRate = (failed / total) * 100;
    if (hourlyFailRate > 30) {
      await this.numberRepo.update(numberId, {
        is_active: false,
        status: WhatsAppNumberStatus.INACTIVE,
      });
      this.logger.warn(
        `[RiskAI] Block detected on number ${numberId}: ${failed}/${total} failures in last hour — cooldown applied`,
      );
      return true;
    }

    return false;
  }
}

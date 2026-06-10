import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsAppNumberStatus } from '../entities/enums';
import { getReleaseAllowance } from '../shared/number-limits';

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

      if (failRate > 30) score += 40;
      else if (failRate > 15) score += 20;

      if (replyRate < 2 && total > 20) score += 20;
    }

    const releaseAllowance = getReleaseAllowance(number.warmup_level);
    if (releaseAllowance > 0 && (number.daily_sent / releaseAllowance) >= 0.9) {
      score += 15;
    }

    const finalScore = Math.min(100, score);
    await this.numberRepo.update(numberId, { risk_score: finalScore });
    return finalScore;
  }

  async isNumberSafe(numberId: string): Promise<boolean> {
    const score = await this.calculateRiskScore(numberId);
    return score < 60;
  }

  /** Display-only — never pauses or deactivates numbers. */
  async shouldPauseNumber(_numberId: string): Promise<boolean> {
    return false;
  }

  async getRiskyNumbers(): Promise<WhatsappNumber[]> {
    return this.numberRepo
      .createQueryBuilder('n')
      .where('n.risk_score >= 60')
      .andWhere('n.is_active = true')
      .getMany();
  }

  /** Display-only — never deactivates numbers. */
  async checkHourlyBlockDetection(_numberId: string): Promise<boolean> {
    return false;
  }
}

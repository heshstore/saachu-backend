import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { ReplyStatus } from '../entities/enums';

interface LogStats {
  sent_30d: number;
  reads_30d: number;
  replies_30d: number;
  fails_30d: number;
  last_read_at: Date | null;
}

@Injectable()
export class AudienceAiService {
  private readonly logger = new Logger(AudienceAiService.name);

  constructor(
    @InjectRepository(MarketingAudience)
    private readonly repo: Repository<MarketingAudience>,
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async scoreAudience(phone: string): Promise<number> {
    const member = await this.repo.findOne({ where: { phone } });
    if (!member) return 0;
    return this._computeScore(member);
  }

  // Batch score + fatigue update using per-phone log stats — one query for the whole audience
  async updateScores(): Promise<void> {
    type AudienceRow = {
      id: string;
      phone: string;
      name: string | null;
      city: string | null;
      business_type: string | null;
      customer_id: number | null;
      reply_status: ReplyStatus;
      last_contacted_at: Date | null;
      quality_score: string;
      fatigue_score: string;
      sent_30d: string;
      reads_30d: string;
      replies_30d: string;
      fails_30d: string;
      last_read_at: Date | null;
    };

    const rows: AudienceRow[] = await this.ds.query(`
      SELECT
        a.id,
        a.phone,
        a.name,
        a.city,
        a.business_type,
        a.customer_id,
        a.reply_status,
        a.last_contacted_at,
        a.quality_score,
        a.fatigue_score,
        COALESCE(COUNT(l.id) FILTER (WHERE l.sent_at >= NOW() - INTERVAL '30 days'), 0)                                 AS sent_30d,
        COALESCE(COUNT(l.id) FILTER (WHERE l.status IN ('read','replied') AND l.sent_at >= NOW() - INTERVAL '30 days'), 0) AS reads_30d,
        COALESCE(COUNT(l.id) FILTER (WHERE l.status = 'replied' AND l.sent_at >= NOW() - INTERVAL '30 days'), 0)        AS replies_30d,
        COALESCE(COUNT(l.id) FILTER (WHERE l.status = 'failed'  AND l.sent_at >= NOW() - INTERVAL '30 days'), 0)        AS fails_30d,
        MAX(l.sent_at) FILTER (WHERE l.status IN ('read','replied'))                                                     AS last_read_at
      FROM marketing_audience a
      LEFT JOIN whatsapp_message_logs l ON l.customer_phone = a.phone
      WHERE a.opt_out = false
      GROUP BY a.id, a.phone, a.name, a.city, a.business_type,
               a.customer_id, a.reply_status, a.last_contacted_at, a.quality_score, a.fatigue_score
    `);

    let updated = 0;
    for (const row of rows) {
      const member: MarketingAudience = {
        id: row.id,
        phone: row.phone,
        name: row.name,
        city: row.city,
        business_type: row.business_type,
        customer_id: row.customer_id,
        reply_status: row.reply_status,
        last_contacted_at: row.last_contacted_at,
        quality_score: parseFloat(row.quality_score),
        fatigue_score: parseFloat(row.fatigue_score),
      } as MarketingAudience;

      const logStats: LogStats = {
        sent_30d: parseInt(row.sent_30d, 10),
        reads_30d: parseInt(row.reads_30d, 10),
        replies_30d: parseInt(row.replies_30d, 10),
        fails_30d: parseInt(row.fails_30d, 10),
        last_read_at: row.last_read_at,
      };

      const newScore   = this._computeScore(member, logStats);
      const newFatigue = this._computeFatigueScore(logStats);

      const scoreChanged   = Math.abs(newScore   - member.quality_score)  > 1;
      const fatigueChanged = Math.abs(newFatigue - (member.fatigue_score ?? 0)) > 1;

      if (scoreChanged || fatigueChanged) {
        await this.repo.update(row.id, { quality_score: newScore, fatigue_score: newFatigue });
        updated++;
      }
    }

    this.logger.log(`[AudienceAI] updateScores: updated ${updated}/${rows.length} members`);
  }

  // Apply behavioral cooldowns:
  //   3+ sends in 14 days with 0 replies       → 14-day cooldown
  //   3+ sends in 30 days with 0 reads         → 30-day cooldown
  //   fatigue_score >= 70 (high fatigue)        → 45-day cooldown (extended suppression)
  async applyCooldowns(): Promise<void> {
    // 14-day cooldown: sent 3+ times recently, never replied
    // Validation contacts (is_test_contact=true) are excluded — their cooldown is bypassed
    // during audience selection and we avoid polluting their cooldown_until field.
    const r14 = await this.ds.query(`
      UPDATE marketing_audience a
      SET cooldown_until = NOW() + INTERVAL '14 days'
      WHERE a.opt_out = false
        AND a.is_test_contact IS NOT TRUE
        AND (a.cooldown_until IS NULL OR a.cooldown_until <= NOW())
        AND (
          SELECT COUNT(*) FROM whatsapp_message_logs l
          WHERE l.customer_phone = a.phone
            AND l.sent_at >= NOW() - INTERVAL '14 days'
        ) >= 3
        AND (
          SELECT COUNT(*) FROM whatsapp_message_logs l
          WHERE l.customer_phone = a.phone
            AND l.status = 'replied'
            AND l.sent_at >= NOW() - INTERVAL '14 days'
        ) = 0
    `);

    // 30-day cooldown: sent 3+ times, never read in 30 days
    const r30 = await this.ds.query(`
      UPDATE marketing_audience a
      SET cooldown_until = NOW() + INTERVAL '30 days'
      WHERE a.opt_out = false
        AND a.is_test_contact IS NOT TRUE
        AND (a.cooldown_until IS NULL OR a.cooldown_until <= NOW())
        AND (
          SELECT COUNT(*) FROM whatsapp_message_logs l
          WHERE l.customer_phone = a.phone
            AND l.sent_at >= NOW() - INTERVAL '30 days'
        ) >= 3
        AND (
          SELECT COUNT(*) FROM whatsapp_message_logs l
          WHERE l.customer_phone = a.phone
            AND l.status IN ('read','replied')
            AND l.sent_at >= NOW() - INTERVAL '30 days'
        ) = 0
    `);

    // 45-day fatigue cooldown: high fatigue score — repeatedly unresponsive
    const r45 = await this.ds.query(`
      UPDATE marketing_audience a
      SET cooldown_until = NOW() + INTERVAL '45 days'
      WHERE a.opt_out = false
        AND a.is_test_contact IS NOT TRUE
        AND a.fatigue_score >= 70
        AND (a.cooldown_until IS NULL OR a.cooldown_until < NOW() + INTERVAL '30 days')
    `);

    const n14 = r14?.[1] ?? 0;
    const n30 = r30?.[1] ?? 0;
    const n45 = r45?.[1] ?? 0;
    this.logger.log(`[AudienceAI] Cooldowns applied: ${n14} 14-day, ${n30} 30-day, ${n45} 45-day (fatigue)`);
  }

  // Reset cooldown for a contact who just replied (they're interested — re-prioritize)
  async resetCooldown(phone: string): Promise<void> {
    await this.repo.update(
      { phone },
      { cooldown_until: null as any, last_reply_at: new Date() },
    );
  }

  async filterByQuality(minScore: number): Promise<MarketingAudience[]> {
    const now = new Date();

    // Validation contacts: is_test_contact=true always pass — cooldown and quality score
    // are bypassed so internal test numbers remain sendable for every validation run.
    // Only hard safety rules (opt_out, is_whatsapp_valid) still apply.
    const validationContacts = await this.repo
      .createQueryBuilder('a')
      .where('a.is_test_contact = true')
      .andWhere('a.opt_out = false')
      .andWhere('a.is_whatsapp_valid = true')
      .orderBy('a.quality_score', 'DESC')
      .getMany();

    if (process.env.WHATSAPP_ENGINE_TEST_ONLY === 'true') {
      const allTestContacts = await this.repo.find({ where: { is_test_contact: true } });
      this.logger.log(`[MKT_AUDIENCE_FETCH] validation contacts in DB: ${allTestContacts.length} total, ${validationContacts.length} eligible`);
      for (const c of allTestContacts) {
        const skippedByValidation = !validationContacts.find(v => v.id === c.id);
        const skipReasons: string[] = [];
        if (c.opt_out) skipReasons.push('opt_out=true');
        if (!c.is_whatsapp_valid) skipReasons.push('is_whatsapp_valid=false');
        const bypassedReasons: string[] = [];
        if (Number(c.quality_score) < minScore) bypassedReasons.push(`quality_score=${c.quality_score}<${minScore}(BYPASSED)`);
        if (c.cooldown_until && c.cooldown_until > now) bypassedReasons.push(`cooldown_until=${c.cooldown_until?.toISOString()}(BYPASSED)`);
        this.logger.log(
          `[MKT_AUDIENCE_FILTER] phone=${c.phone} is_test_contact=true ` +
          `opt_out=${c.opt_out} is_whatsapp_valid=${c.is_whatsapp_valid} ` +
          `quality_score=${c.quality_score} cooldown_until=${c.cooldown_until?.toISOString() ?? 'NULL'} ` +
          `passes=${!skippedByValidation} ` +
          `skip_reason=${skipReasons.join(', ') || 'none'} ` +
          `bypassed=${bypassedReasons.join(', ') || 'none'}`,
        );
      }
    }

    // Regular contacts: full filter applies. Exclude test contacts (already in validationContacts).
    const regularContacts = await this.repo
      .createQueryBuilder('a')
      .where('a.opt_out = false')
      .andWhere('a.is_whatsapp_valid = true')
      .andWhere('a.quality_score >= :minScore', { minScore })
      .andWhere('(a.cooldown_until IS NULL OR a.cooldown_until <= :now)', { now })
      .andWhere('a.is_test_contact IS NOT TRUE')
      .orderBy('a.quality_score', 'DESC')
      .getMany();

    const result = [...validationContacts, ...regularContacts];
    this.logger.log(
      `[MKT_AUDIENCE_FETCH] filterByQuality(minScore=${minScore}): ` +
      `${validationContacts.length} validation (bypassed restrictions) + ` +
      `${regularContacts.length} regular = ${result.length} total`,
    );
    return result;
  }

  _computeScore(member: MarketingAudience, logs?: LogStats): number {
    let score = 40;

    // Profile completeness
    if (member.name) score += 10;
    if (member.city) score += 8;
    if (member.business_type) score += 7;
    if (member.customer_id) score += 15;

    // Reply/lead status
    if (member.reply_status === ReplyStatus.REPLIED) score += 15;
    if (member.reply_status === ReplyStatus.LEAD_CREATED) score += 20;

    // Recency penalty based on last_contacted_at
    if (member.last_contacted_at) {
      const daysSince = (Date.now() - new Date(member.last_contacted_at).getTime()) / 86_400_000;
      if (daysSince < 3)       score -= 30;
      else if (daysSince < 7)  score -= 15;
      else if (daysSince > 30) score -= 5;
    }

    // Behavioral log signals (last 30 days)
    if (logs) {
      if (logs.reads_30d > 0)   score += 12;  // reads messages
      if (logs.replies_30d > 0) score += 18;  // replied recently
      if (logs.fails_30d >= 3)  score -= 20;  // high failure rate
      if (logs.sent_30d >= 5 && logs.reads_30d === 0) score -= 25; // completely ignoring
      if (logs.last_read_at) {
        const daysSinceRead = (Date.now() - new Date(logs.last_read_at).getTime()) / 86_400_000;
        if (daysSinceRead < 7) score += 10;  // read recently
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  // Fatigue score: 0 = fresh/engaged, 100 = completely burned out
  // Driven by: repeated ignores, no-reads, no-replies over the last 30 days
  _computeFatigueScore(logs: LogStats): number {
    if (logs.sent_30d === 0) return 0;

    let score = 0;
    const ignoreRate = logs.sent_30d > 0
      ? (logs.sent_30d - logs.reads_30d) / logs.sent_30d
      : 0;
    const noReplyRate = logs.reads_30d > 0
      ? (logs.reads_30d - logs.replies_30d) / logs.reads_30d
      : 0;

    // Base fatigue from ignores
    if (ignoreRate >= 0.9)       score += 50;
    else if (ignoreRate >= 0.7)  score += 35;
    else if (ignoreRate >= 0.5)  score += 20;

    // Additional fatigue from no-replies after reading
    if (noReplyRate >= 0.9 && logs.reads_30d >= 2) score += 25;
    else if (noReplyRate >= 0.7 && logs.reads_30d >= 2) score += 15;

    // Volume penalty: high send volume with zero engagement = severe fatigue
    if (logs.sent_30d >= 5 && logs.reads_30d === 0)   score += 25;
    if (logs.sent_30d >= 8 && logs.replies_30d === 0)  score += 10;

    return Math.max(0, Math.min(100, score));
  }
}

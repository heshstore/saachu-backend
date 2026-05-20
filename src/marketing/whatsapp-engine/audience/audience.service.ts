import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { ReplyStatus } from '../entities/enums';

@Injectable()
export class AudienceService {
  constructor(
    @InjectRepository(MarketingAudience)
    private repo: Repository<MarketingAudience>,
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  findAll(): Promise<MarketingAudience[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<MarketingAudience> {
    const a = await this.repo.findOne({ where: { id } });
    if (!a) throw new NotFoundException(`Audience member ${id} not found`);
    return a;
  }

  create(dto: Partial<MarketingAudience>): Promise<MarketingAudience> {
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: Partial<MarketingAudience>): Promise<MarketingAudience> {
    await this.findOne(id);
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.repo.delete(id);
  }

  // Upsert by phone (unique constraint); updates name/city/business_type/source on conflict
  async bulkUpsert(rows: Partial<MarketingAudience>[]): Promise<{ upserted: number }> {
    if (!rows.length) return { upserted: 0 };
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(MarketingAudience)
      .values(rows as any)
      .orUpdate(['name', 'city', 'business_type', 'source', 'customer_id'], ['phone'])
      .execute();
    return { upserted: rows.length };
  }

  async markOptOut(id: string): Promise<MarketingAudience> {
    await this.repo.update(id, { opt_out: true, reply_status: ReplyStatus.OPTED_OUT });
    return this.findOne(id);
  }

  // Returns audience eligible for sends: not opted out, WA valid, not in cooldown, above quality threshold
  findEligible(minScore = 0, testOnly = false): Promise<MarketingAudience[]> {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.opt_out = false')
      .andWhere('a.is_whatsapp_valid = true')
      .andWhere('a.quality_score >= :minScore', { minScore })
      .andWhere('(a.cooldown_until IS NULL OR a.cooldown_until <= :now)', { now: new Date() });

    if (testOnly) {
      qb.andWhere('a.is_test_contact = true');
    }

    return qb.orderBy('a.quality_score', 'DESC').getMany();
  }

  findTestContacts(): Promise<MarketingAudience[]> {
    return this.repo.find({ where: { is_test_contact: true }, order: { created_at: 'DESC' } });
  }

  getTestPhones(): Promise<string[]> {
    return this.repo
      .createQueryBuilder('a')
      .select('a.phone', 'phone')
      .where('a.is_test_contact = true')
      .andWhere('a.opt_out = false')
      .getRawMany<{ phone: string }>()
      .then((rows) => rows.map((r) => r.phone));
  }

  async markAsTestContact(id: string, isTest: boolean): Promise<MarketingAudience> {
    await this.repo.update(id, { is_test_contact: isTest });
    return this.findOne(id);
  }

  async getHealthStats(): Promise<{
    total: number;
    opted_out: number;
    in_cooldown: number;
    eligible: number;
    score_distribution: { bucket: string; count: number }[];
  }> {
    type StatRow = {
      total: string;
      opted_out: string;
      in_cooldown: string;
      eligible: string;
      s0_20: string;
      s21_40: string;
      s41_60: string;
      s61_80: string;
      s81_100: string;
    };

    const rows: StatRow[] = await this.ds.query(`
      SELECT
        COUNT(*)                                                                   AS total,
        COUNT(*) FILTER (WHERE opt_out = true)                                     AS opted_out,
        COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()) AS in_cooldown,
        COUNT(*) FILTER (
          WHERE opt_out = false
            AND is_whatsapp_valid = true
            AND (cooldown_until IS NULL OR cooldown_until <= NOW())
        )                                                                          AS eligible,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 0  AND 20)                    AS s0_20,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 21 AND 40)                    AS s21_40,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 41 AND 60)                    AS s41_60,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 61 AND 80)                    AS s61_80,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 81 AND 100)                   AS s81_100
      FROM marketing_audience
    `);

    const r = rows[0];
    return {
      total: parseInt(r.total, 10),
      opted_out: parseInt(r.opted_out, 10),
      in_cooldown: parseInt(r.in_cooldown, 10),
      eligible: parseInt(r.eligible, 10),
      score_distribution: [
        { bucket: '0–20',   count: parseInt(r.s0_20,   10) },
        { bucket: '21–40',  count: parseInt(r.s21_40,  10) },
        { bucket: '41–60',  count: parseInt(r.s41_60,  10) },
        { bucket: '61–80',  count: parseInt(r.s61_80,  10) },
        { bucket: '81–100', count: parseInt(r.s81_100, 10) },
      ],
    };
  }
}

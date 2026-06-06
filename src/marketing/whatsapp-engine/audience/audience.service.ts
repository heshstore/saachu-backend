import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, DeepPartial } from 'typeorm';
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

  // Check which phones already exist in the promotional DB.
  // Returns full existing records so the frontend can present conflict resolution.
  async checkConflicts(phones: string[]): Promise<{
    phone: string;
    id: string;
    name: string | null;
    city: string | null;
    business_type: string | null;
    customer_id: number | null;  // non-null = customer-linked, never overwrite
  }[]> {
    if (!phones.length) return [];
    const rows: any[] = await this.ds.query(
      `SELECT id, phone, name, city, business_type, customer_id
       FROM marketing_audience
       WHERE phone = ANY($1)`,
      [phones],
    );
    return rows;
  }

  // Upsert by phone — caller is responsible for pre-resolving conflicts.
  // Customer-linked rows (customer_id IS NOT NULL) are never overwritten even if passed in.
  async bulkUpsert(rows: Partial<MarketingAudience>[]): Promise<{
    total: number; created: number; updated: number; errors: { phone: string; reason: string }[];
  }> {
    if (!rows.length) return { total: 0, created: 0, updated: 0, errors: [] };

    const errors: { phone: string; reason: string }[] = [];
    const valid = rows.filter((r) => {
      const hasPhone = !!r.phone?.trim();
      const hasEmail = !!r.email?.trim();
      if (!hasPhone && !hasEmail) {
        errors.push({ phone: String(r.phone ?? r.email ?? ''), reason: 'Requires phone or email' });
        return false;
      }
      return true;
    });

    if (!valid.length) return { total: rows.length, created: 0, updated: 0, errors };

    // Split into phone-keyed rows (dedup on phone) and email-only rows (plain insert, no dedup).
    const phoneRows  = valid.filter(r => !!r.phone?.trim()).map(r => ({ ...r, phone: r.phone!.trim() }));
    const emailOnly  = valid.filter(r => !r.phone?.trim());

    let created = emailOnly.length;
    let updated = 0;

    // Email-only rows: plain insert, no dedup possible without phone.
    if (emailOnly.length) {
      await this.repo.save(emailOnly.map(r => this.repo.create(r as DeepPartial<MarketingAudience>)));
    }

    if (phoneRows.length) {
      const phones = phoneRows.map(r => r.phone);
      const existing: { phone: string; customer_id: number | null }[] = await this.ds.query(
        `SELECT phone, customer_id FROM marketing_audience WHERE phone = ANY($1)`,
        [phones],
      );
      const existingMap = new Map(existing.map(e => [e.phone, e]));

      // Customer-linked rows are protected — never overwrite.
      phoneRows.forEach(r => {
        const ex = existingMap.get(r.phone);
        if (ex && ex.customer_id != null)
          errors.push({ phone: r.phone, reason: 'Linked to customer — cannot overwrite' });
      });

      const safe = phoneRows.filter(r => {
        const ex = existingMap.get(r.phone);
        return !ex || ex.customer_id == null;
      });

      if (safe.length) {
        await this.repo
          .createQueryBuilder()
          .insert()
          .into(MarketingAudience)
          .values(safe as any)
          .orUpdate(
            ['name', 'customer_name', 'company', 'mobile_2', 'email',
             'city', 'state', 'country', 'address', 'gst',
             'business_type', 'source', 'notes'],
            ['phone'],
          )
          .execute();
        updated = safe.filter(r => existingMap.has(r.phone)).length;
        created += safe.length - updated;
      }
    }

    return { total: rows.length, created, updated, errors };
  }

  // Promotion history for a contact: all messages sent to this phone number.
  async getContactHistory(id: string): Promise<{
    campaign_id: string | null;
    campaign_name: string | null;
    status: string;
    sent_at: string | null;
    reply_received: boolean;
  }[]> {
    const contact = await this.findOne(id);
    return this.ds.query(
      `SELECT l.campaign_id, c.campaign_name, l.status, l.sent_at, l.reply_received
       FROM whatsapp_message_logs l
       LEFT JOIN marketing_campaigns c ON c.id = l.campaign_id
       WHERE l.customer_phone = $1
       ORDER BY l.sent_at DESC
       LIMIT 100`,
      [contact.phone],
    );
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

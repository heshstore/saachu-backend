import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';

@Injectable()
export class NumbersService {
  constructor(
    @InjectRepository(WhatsappNumber)
    private repo: Repository<WhatsappNumber>,
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  findAll(): Promise<WhatsappNumber[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<WhatsappNumber> {
    const n = await this.repo.findOne({ where: { id } });
    if (!n) throw new NotFoundException(`WhatsApp number ${id} not found`);
    return n;
  }

  create(dto: Partial<WhatsappNumber>): Promise<WhatsappNumber> {
    if (dto.phone) dto = { ...dto, phone: this._toE164(dto.phone) };
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: Partial<WhatsappNumber>): Promise<WhatsappNumber> {
    await this.findOne(id);
    if (dto.phone) dto = { ...dto, phone: this._toE164(dto.phone) };
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  private _toE164(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return '+' + digits;
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.repo.delete(id);
  }

  // Reset all daily_sent counters to 0 — intended to be called once per day via cron
  async resetDailyCounts(): Promise<void> {
    await this.repo.update({}, { daily_sent: 0 });
  }

  async incrementDailySent(id: string): Promise<void> {
    await this.repo.increment({ id }, 'daily_sent', 1);
  }

  async updateLastMessageSent(id: string): Promise<void> {
    await this.repo.update(id, { last_message_sent_at: new Date() });
  }

  // 7-day daily trend: sent / delivered / read / replied / failed per day
  async getHealthTrend(id: string): Promise<{
    date: string;
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
  }[]> {
    type TrendRow = {
      day: string;
      sent: string;
      delivered: string;
      read: string;
      replied: string;
      failed: string;
    };

    const rows: TrendRow[] = await this.ds.query(
      `SELECT
         TO_CHAR(l.sent_at::DATE, 'YYYY-MM-DD')                               AS day,
         COUNT(*) FILTER (WHERE l.status = 'sent')                            AS sent,
         COUNT(*) FILTER (WHERE l.status = 'delivered')                       AS delivered,
         COUNT(*) FILTER (WHERE l.status = 'read')                            AS read,
         COUNT(*) FILTER (WHERE l.status = 'replied')                         AS replied,
         COUNT(*) FILTER (WHERE l.status = 'failed')                          AS failed
       FROM whatsapp_message_logs l
       WHERE l.number_id = $1
         AND l.sent_at >= NOW() - INTERVAL '7 days'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [id],
    );

    return rows.map((r) => ({
      date: r.day,
      sent: parseInt(r.sent, 10),
      delivered: parseInt(r.delivered, 10),
      read: parseInt(r.read, 10),
      replied: parseInt(r.replied, 10),
      failed: parseInt(r.failed, 10),
    }));
  }
}

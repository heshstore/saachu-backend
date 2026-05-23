import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappReply } from '../entities/whatsapp-reply.entity';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { ReplyStatus } from '../entities/enums';

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    @InjectRepository(WhatsappReply)
    private repo: Repository<WhatsappReply>,
    @InjectRepository(MarketingAudience)
    private audienceRepo: Repository<MarketingAudience>,
  ) {}

  findAll(): Promise<WhatsappReply[]> {
    return this.repo.find({ order: { received_at: 'DESC' }, take: 100 });
  }

  findByPhone(phone: string): Promise<WhatsappReply[]> {
    return this.repo.find({ where: { customer_phone: phone }, order: { received_at: 'DESC' } });
  }

  async markLeadCreated(id: string, leadId: number): Promise<WhatsappReply> {
    const reply = await this.repo.findOne({ where: { id } });
    if (!reply) throw new NotFoundException(`Reply ${id} not found`);
    await this.repo.update(id, { crm_lead_created: true, crm_lead_id: leadId });
    // Reflect in audience table if the phone exists there
    await this.audienceRepo.update(
      { phone: reply.customer_phone },
      { reply_status: ReplyStatus.LEAD_CREATED, last_reply_at: new Date() },
    );
    return this.repo.findOne({ where: { id } }) as Promise<WhatsappReply>;
  }

  // Called internally when an inbound WA message arrives from a marketing-linked number
  async saveReply(dto: Partial<WhatsappReply>): Promise<WhatsappReply> {
    // Hard gate — final guardrail before DB write.
    // Requires: starts with '+', 10–15 digits, valid E.164 pattern.
    const phone = dto.customer_phone ?? '';
    const digits = phone.replace(/\D/g, '');
    const isValidE164 = phone.startsWith('+') &&
      digits.length >= 10 &&
      digits.length <= 15 &&
      /^\+[1-9]\d{9,14}$/.test(phone);

    if (!isValidE164) {
      this.logger.warn(
        `[MKT_REPLY_SAVE_BLOCKED] phone="${phone}" digits=${digits.length} — ` +
        `failed E.164 validation; row not inserted`,
      );
      throw new Error(`[MKT_REPLY_SAVE_BLOCKED] Invalid phone: "${phone}"`);
    }

    const saved = await this.repo.save(this.repo.create(dto));
    if (dto.customer_phone) {
      await this.audienceRepo.update(
        { phone: dto.customer_phone },
        { reply_status: ReplyStatus.REPLIED, last_reply_at: new Date() },
      );
    }
    return saved;
  }
}

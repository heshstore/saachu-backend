import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { QueueStatus } from '../entities/enums';
import { AudienceService } from '../audience/audience.service';

@Injectable()
export class QueueService {
  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private repo: Repository<WhatsappMessageQueue>,
    private readonly audienceService: AudienceService,
  ) {}

  findPending(limit = 5): Promise<WhatsappMessageQueue[]> {
    return this.repo.find({
      where: { status: QueueStatus.PENDING, scheduled_at: LessThanOrEqual(new Date()) },
      order: { priority: 'DESC', scheduled_at: 'ASC' },
      take: limit,
    });
  }

  async findActivePhonesSet(): Promise<Set<string>> {
    const rows = await this.repo
      .createQueryBuilder('q')
      .select('q.customer_phone', 'phone')
      .where('q.status IN (:...statuses)', { statuses: [QueueStatus.PENDING, QueueStatus.PROCESSING] })
      .getRawMany<{ phone: string }>();
    return new Set(rows.map((r) => r.phone));
  }

  findByCampaign(campaignId: string, limit = 200): Promise<WhatsappMessageQueue[]> {
    return this.repo.find({
      where: { campaign_id: campaignId },
      order: { scheduled_at: 'ASC' },
      take: limit,
    });
  }

  enqueue(dto: Partial<WhatsappMessageQueue>): Promise<WhatsappMessageQueue> {
    return this.repo.save(this.repo.create(dto));
  }

  async markProcessing(id: string): Promise<void> {
    await this.repo.update(id, { status: QueueStatus.PROCESSING });
  }

  async markSent(id: string): Promise<void> {
    await this.repo.update(id, { status: QueueStatus.SENT, sent_at: new Date() });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.repo.increment({ id }, 'attempt_count', 1);
    await this.repo.update(id, { status: QueueStatus.FAILED, error_message: error });
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.repo.update(id, { status: QueueStatus.SKIPPED, error_message: reason });
  }

  // Cancel all PENDING items for a campaign (called when campaign is cancelled)
  async cancelCampaignQueue(campaignId: string): Promise<void> {
    await this.repo.update(
      { campaign_id: campaignId, status: QueueStatus.PENDING },
      { status: QueueStatus.SKIPPED, error_message: 'Campaign cancelled' },
    );
  }

  async bulkEnqueue(items: Partial<WhatsappMessageQueue>[]): Promise<number> {
    if (!items.length) return 0;
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(WhatsappMessageQueue)
      .values(items as any)
      .execute();
    return items.length;
  }

  // Build queue items from eligible audience for a campaign launch
  async buildFromCampaign(campaign: MarketingCampaign): Promise<number> {
    const audience = await this.audienceService.findEligible();

    // Avoid re-queuing phones already in this campaign's queue
    const existing = await this.repo
      .createQueryBuilder('q')
      .select('q.customer_phone')
      .where('q.campaign_id = :cid', { cid: campaign.id })
      .andWhere('q.status NOT IN (:...skip)', { skip: [QueueStatus.SKIPPED, QueueStatus.FAILED] })
      .getRawMany();
    const existingPhones = new Set<string>(existing.map((r) => r.q_customer_phone as string));

    const now = new Date();
    const [startH, startM] = campaign.send_window_start.split(':').map(Number);
    let cursor = new Date(now);
    cursor.setHours(startH, startM, 0, 0);
    if (cursor < now) cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);

    const items: Partial<WhatsappMessageQueue>[] = [];
    for (const member of audience) {
      if (existingPhones.has(member.phone)) continue;
      if (items.length >= campaign.daily_target) break;

      items.push({
        campaign_id: campaign.id,
        template_id: campaign.template_id ?? undefined,
        customer_phone: member.phone,
        customer_id: member.customer_id ?? undefined,
        scheduled_at: new Date(cursor),
        status: QueueStatus.PENDING,
        priority: Math.round(Number(member.quality_score)),
        message_payload: {
          name: member.name ?? '',
          city: member.city ?? '',
          business_type: member.business_type ?? '',
        },
      });

      const delayMs =
        (campaign.random_delay_min +
          Math.random() * (campaign.random_delay_max - campaign.random_delay_min)) *
        1000;
      cursor = new Date(cursor.getTime() + delayMs);
    }

    if (!items.length) return 0;
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(WhatsappMessageQueue)
      .values(items as any)
      .execute();
    return items.length;
  }
}

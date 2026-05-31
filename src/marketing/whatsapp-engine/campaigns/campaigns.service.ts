import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { CampaignStatus } from '../entities/enums';
import { QueueService } from '../queue/queue.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';

// Fixed rules applied to every promotion campaign — immutable at create time.
const PROMOTION_RULES = {
  campaign_type:      'promotion',
  send_window_start:  '10:00',
  send_window_end:    '18:00',
  random_delay_min:   30,
  random_delay_max:   120,
  daily_target:       9999, // system-managed; queue generation drives actual volume
} as const;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectRepository(MarketingCampaign)
    private repo: Repository<MarketingCampaign>,
    private readonly queueService: QueueService,
    private readonly marketingWa: MarketingWhatsAppService,
  ) {}

  findAll(): Promise<MarketingCampaign[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<MarketingCampaign> {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Campaign ${id} not found`);
    return c;
  }

  create(dto: Partial<MarketingCampaign>): Promise<MarketingCampaign> {
    // Promotion campaigns have all scheduling/audience rules locked in by the system.
    // Overwrite anything the client may have sent for those fields.
    if (dto.is_promotion) {
      Object.assign(dto, PROMOTION_RULES);
    }
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: Partial<MarketingCampaign>): Promise<MarketingCampaign> {
    const existing = await this.findOne(id);
    // Promotion rule fields cannot be overridden after creation.
    if (existing.is_promotion) {
      for (const key of Object.keys(PROMOTION_RULES) as (keyof typeof PROMOTION_RULES)[]) {
        delete (dto as any)[key];
      }
    }
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const c = await this.findOne(id);
    if (c.status === CampaignStatus.RUNNING) {
      throw new BadRequestException('Pause or cancel the campaign before deleting');
    }
    await this.repo.delete(id);
  }

  async launch(id: string): Promise<{ campaign: MarketingCampaign; queued: number }> {
    const campaign = await this.findOne(id);

    const launchable = [CampaignStatus.DRAFT, CampaignStatus.PAUSED, CampaignStatus.SCHEDULED];
    if (!launchable.includes(campaign.status)) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} — can only launch from DRAFT, PAUSED, or SCHEDULED`,
      );
    }
    if (!campaign.template_id) {
      throw new BadRequestException('Set a template_id on the campaign before launching');
    }

    // Launch gate: at least one WA number must be connected.
    if (!this.marketingWa.isAnyConnected()) {
      throw new BadRequestException(
        'No WhatsApp numbers are connected. Connect at least one number before launching.',
      );
    }

    await this.repo.update(id, { status: CampaignStatus.RUNNING });
    const queued = await this.queueService.buildFromCampaign({ ...campaign, status: CampaignStatus.RUNNING });

    this.logger.log(
      `[CAMPAIGN_LAUNCH] id=${id} name="${campaign.campaign_name}" ` +
      `is_promotion=${campaign.is_promotion} test_mode=${campaign.test_mode} queued=${queued}`,
    );

    return { campaign: await this.findOne(id), queued };
  }

  async pause(id: string): Promise<MarketingCampaign> {
    const campaign = await this.findOne(id);
    if (campaign.status !== CampaignStatus.RUNNING) {
      throw new BadRequestException('Campaign is not running');
    }
    await this.repo.update(id, { status: CampaignStatus.PAUSED });
    return this.findOne(id);
  }

  async resume(id: string): Promise<{ campaign: MarketingCampaign; queued: number }> {
    return this.launch(id);
  }

  async cancel(id: string): Promise<MarketingCampaign> {
    await this.findOne(id);
    await this.repo.update(id, { status: CampaignStatus.CANCELLED });
    await this.queueService.cancelCampaignQueue(id);
    return this.findOne(id);
  }
}

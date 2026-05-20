import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { CampaignStatus } from '../entities/enums';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class CampaignsService {
  constructor(
    @InjectRepository(MarketingCampaign)
    private repo: Repository<MarketingCampaign>,
    private readonly queueService: QueueService,
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
    return this.repo.save(this.repo.create(dto));
  }

  async update(id: string, dto: Partial<MarketingCampaign>): Promise<MarketingCampaign> {
    await this.findOne(id);
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
    await this.repo.update(id, { status: CampaignStatus.RUNNING });
    const queued = await this.queueService.buildFromCampaign({ ...campaign, status: CampaignStatus.RUNNING });
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

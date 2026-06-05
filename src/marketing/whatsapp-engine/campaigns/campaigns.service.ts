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

    const launchable = [
      CampaignStatus.DRAFT, CampaignStatus.PAUSED, CampaignStatus.SCHEDULED,
      CampaignStatus.COMPLETED, CampaignStatus.PARTIALLY_COMPLETED, CampaignStatus.FAILED,
    ];
    if (!launchable.includes(campaign.status)) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} — can only launch from DRAFT, PAUSED, SCHEDULED, COMPLETED, PARTIALLY_COMPLETED, or FAILED`,
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
    this.logger.log(
      `[CAMPAIGN_AUDIT] launch_complete: id=${id} name="${campaign.campaign_name}" ` +
      `template_id=${campaign.template_id ?? 'none'} test_mode=${campaign.test_mode} ` +
      `is_promotion=${campaign.is_promotion} queued_items=${queued}`,
    );
    if (queued === 0) {
      this.logger.warn(
        `[CAMPAIGN_AUDIT] launch_zero_queue: id=${id} name="${campaign.campaign_name}" — ` +
        `campaign launched but ZERO items were queued. Check: audience eligibility, number connectivity, daily_target cap.`,
      );
    }

    return { campaign: await this.findOne(id), queued };
  }

  /**
   * Pause semantics: sets campaign status to PAUSED and stops future autonomous
   * queue builds for this campaign. It does NOT cancel existing PENDING items —
   * the sender tick continues processing them until the queue drains.
   * Use cancel() to immediately stop all sends (marks PENDING items as SKIPPED).
   */
  async pause(id: string): Promise<{ campaign: MarketingCampaign; warning: string }> {
    const campaign = await this.findOne(id);
    if (campaign.status !== CampaignStatus.RUNNING) {
      throw new BadRequestException('Campaign is not running');
    }
    await this.repo.update(id, { status: CampaignStatus.PAUSED });
    const updated = await this.findOne(id);
    this.logger.warn(
      `[CAMPAIGN_PAUSED] id=${id} name="${campaign.campaign_name}" — ` +
      `status=PAUSED. Existing PENDING queue items WILL CONTINUE TO SEND. ` +
      `Use Cancel to immediately stop all sends (marks PENDING as SKIPPED).`,
    );
    return {
      campaign: updated,
      warning: 'Pause stops future queue creation. Existing pending messages will continue to send. Use Cancel to immediately stop all sends.',
    };
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

  /**
   * Automatic completion evaluation — called after every queue item reaches a terminal state.
   * Only transitions campaigns that are currently RUNNING; all other statuses are left untouched.
   *
   * Decision table (after remainingActive = 0):
   *   sent > 0 AND failed = 0 AND skipped = 0  →  COMPLETED
   *   sent > 0 AND (failed > 0 OR skipped > 0)  →  PARTIALLY_COMPLETED
   *   sent = 0                                   →  FAILED
   */
  async evaluateCompletion(campaignId: string): Promise<void> {
    const campaign = await this.repo.findOne({ where: { id: campaignId } });
    if (!campaign || campaign.status !== CampaignStatus.RUNNING) return;

    const counts = await this.queueService.getCampaignQueueCounts(campaignId);
    const remainingActive = counts.pending + counts.processing;

    if (remainingActive > 0) return; // still work to do

    let terminal: CampaignStatus;
    if (counts.sent > 0 && counts.failed === 0 && counts.skipped === 0) {
      terminal = CampaignStatus.COMPLETED;
    } else if (counts.sent > 0) {
      terminal = CampaignStatus.PARTIALLY_COMPLETED;
    } else {
      terminal = CampaignStatus.FAILED;
    }

    // Atomic: WHERE status='running' means only the first concurrent caller wins.
    // A second concurrent call that also reached this point will find status already
    // terminal and affect 0 rows — a safe no-op. This is the race-condition guard.
    const result = await this.repo.update(
      { id: campaignId, status: CampaignStatus.RUNNING },
      { status: terminal },
    );
    const affected = (result as any)?.affected ?? null;
    if (affected === 0) {
      // Race guard fired: a concurrent evaluateCompletion already wrote the terminal status.
      // No action needed — the campaign is already in its correct terminal state.
      this.logger.log(
        `[CAMPAIGN_COMPLETION_RACE_GUARD] id=${campaignId} — WHERE status=running matched 0 rows; ` +
        `concurrent evaluation already transitioned campaign (no-op)`,
      );
      return;
    }
    this.logger.log(
      `[CAMPAIGN_COMPLETION] id=${campaignId} name="${campaign.campaign_name}" ` +
      `→ ${terminal} (sent=${counts.sent} failed=${counts.failed} skipped=${counts.skipped} ` +
      `affected=${affected ?? 'unknown'})`,
    );
  }
}

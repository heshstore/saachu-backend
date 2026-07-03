import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { QueueStatus, CampaignStatus } from '../entities/enums';
import { EngineAuditService, AuditEvent } from './engine-audit.service';

// Items stuck in PROCESSING beyond this threshold are considered orphaned
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 3;

@Injectable()
export class ProcessingWatchdogService {
  private readonly logger = new Logger(ProcessingWatchdogService.name);
  private _running = false;

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private readonly queueRepo: Repository<WhatsappMessageQueue>,
    @InjectRepository(MarketingCampaign)
    private readonly campaignRepo: Repository<MarketingCampaign>,
    private readonly auditService: EngineAuditService,
  ) {}

  @Interval(5 * 60 * 1000)
  async recoverStuckItems(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;
    if (this._running) {
      this.logger.warn(
        '[Watchdog] Previous recovery run still in progress — skipping tick',
      );
      return;
    }
    this._running = true;
    try {
      await this._recoverStuckItemsInternal();
      await this._completeDrainedCampaigns();
    } finally {
      this._running = false;
    }
  }

  /**
   * Auto-completes broadcast campaigns (is_promotion=false) whose queue has fully
   * drained: no PENDING or PROCESSING items remain, and at least one SENT item exists
   * (proving the campaign actually ran). Promotion campaigns (is_promotion=true) are
   * excluded — they are designed to refill daily from the autonomous engine.
   *
   * Runs inside the existing 5-minute watchdog interval. No new cron needed.
   */
  private async _completeDrainedCampaigns(): Promise<void> {
    const running = await this.campaignRepo.find({
      where: { status: CampaignStatus.RUNNING, is_promotion: false },
    });
    if (!running.length) return;

    for (const campaign of running) {
      const [pending, processing, sent] = await Promise.all([
        this.queueRepo.count({
          where: { campaign_id: campaign.id, status: QueueStatus.PENDING },
        }),
        this.queueRepo.count({
          where: { campaign_id: campaign.id, status: QueueStatus.PROCESSING },
        }),
        this.queueRepo.count({
          where: { campaign_id: campaign.id, status: QueueStatus.SENT },
        }),
      ]);

      if (pending === 0 && processing === 0 && sent >= 1) {
        await this.campaignRepo.update(campaign.id, {
          status: CampaignStatus.COMPLETED,
        });
        this.logger.log(
          `[CAMPAIGN_AUTO_COMPLETED] id=${campaign.id} name="${campaign.campaign_name}" ` +
            `sent=${sent} — broadcast queue drained, status → COMPLETED`,
        );
      }
    }
  }

  private async _recoverStuckItemsInternal(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await this.queueRepo.find({
      where: { status: QueueStatus.PROCESSING, updated_at: LessThan(cutoff) },
    });

    if (!stuck.length) return;

    this.logger.warn(
      `[Watchdog] Found ${stuck.length} stuck PROCESSING item(s) — recovering`,
    );

    for (const item of stuck) {
      if (item.attempt_count >= MAX_ATTEMPTS) {
        await this.queueRepo.update(item.id, {
          status: QueueStatus.FAILED,
          error_message: `Watchdog: exceeded ${MAX_ATTEMPTS} attempts`,
        });
        await this.auditService.log({
          event: AuditEvent.SEND_SKIPPED,
          customer_phone: item.customer_phone,
          number_id: item.number_id ?? undefined,
          reason: `Watchdog: permanently failed after ${MAX_ATTEMPTS} stuck recoveries`,
        });
        this.logger.warn(
          `[Watchdog] Permanently failed ${item.id} (${item.customer_phone}) after ${MAX_ATTEMPTS} attempts`,
        );
      } else {
        await this.queueRepo.increment({ id: item.id }, 'attempt_count', 1);
        await this.queueRepo.update(item.id, { status: QueueStatus.PENDING });
        this.logger.log(
          `[Watchdog] Reset ${item.id} to PENDING (attempt ${item.attempt_count + 1})`,
        );
      }
    }
  }
}

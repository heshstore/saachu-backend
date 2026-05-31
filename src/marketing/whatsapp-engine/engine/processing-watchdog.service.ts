import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { QueueStatus } from '../entities/enums';
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
    private readonly auditService: EngineAuditService,
  ) {}

  @Interval(5 * 60 * 1000)
  async recoverStuckItems(): Promise<void> {
    if (process.env.WHATSAPP_ENGINE_ENABLED === 'false') return;
    if (this._running) {
      this.logger.warn('[Watchdog] Previous recovery run still in progress — skipping tick');
      return;
    }
    this._running = true;
    try {
      await this._recoverStuckItemsInternal();
    } finally {
      this._running = false;
    }
  }

  private async _recoverStuckItemsInternal(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await this.queueRepo.find({
      where: { status: QueueStatus.PROCESSING, updated_at: LessThan(cutoff) },
    });

    if (!stuck.length) return;

    this.logger.warn(`[Watchdog] Found ${stuck.length} stuck PROCESSING item(s) — recovering`);

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
        this.logger.warn(`[Watchdog] Permanently failed ${item.id} (${item.customer_phone}) after ${MAX_ATTEMPTS} attempts`);
      } else {
        await this.queueRepo.increment({ id: item.id }, 'attempt_count', 1);
        await this.queueRepo.update(item.id, { status: QueueStatus.PENDING });
        this.logger.log(`[Watchdog] Reset ${item.id} to PENDING (attempt ${item.attempt_count + 1})`);
      }
    }
  }
}

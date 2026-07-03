import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrmWhatsAppService } from '../crm-whatsapp/crm-whatsapp.service';
import { ProductionAlert } from './entities/production-alert.entity';
import { ProductionJob } from './entities/production-job.entity';

const CTX = 'SYSTEM – PRODUCTION';

@Injectable()
export class ProductionWhatsappService {
  private readonly logger = new Logger(ProductionWhatsappService.name);

  constructor(
    private readonly whatsapp: CrmWhatsAppService,
    @InjectRepository(ProductionAlert)
    private readonly alertRepo: Repository<ProductionAlert>,
  ) {}

  // ── Dedup ─────────────────────────────────────────────────────────────────

  private async alreadySent(
    jobId: number,
    alertType: string,
  ): Promise<boolean> {
    const record = await this.alertRepo.findOne({
      where: { job_id: jobId, alert_type: alertType },
    });
    return !!record;
  }

  private async markSent(
    jobId: number,
    alertType: string,
    userId?: number,
  ): Promise<void> {
    await this.alertRepo.save({
      job_id: jobId,
      alert_type: alertType,
      notified_to: userId ?? 0,
    });
  }

  // ── Fire-and-forget wrapper ───────────────────────────────────────────────

  private send(userId: number, message: string): void {
    this.whatsapp
      .sendToAssignee(userId, message)
      .catch((err) =>
        this.logger.warn(`WA send failed userId=${userId}: ${err?.message}`),
      );
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async sendJobAssigned(job: ProductionJob): Promise<void> {
    if (!job.assigned_to) return;
    if (await this.alreadySent(job.id, 'WA_ASSIGN')) return;

    const message = [
      `📌 Job Assigned`,
      `Job ID: ${job.id}`,
      `Stage: ${job.current_stage}`,
      `Please start work.`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    this.send(job.assigned_to, message);
    await this.markSent(job.id, 'WA_ASSIGN', job.assigned_to);
  }

  async sendDelayAlert(job: ProductionJob): Promise<void> {
    if (!job.assigned_to) return;
    if (await this.alreadySent(job.id, 'WA_DELAY')) return;

    const message = [
      `⚠️ Delay Alert`,
      `Job ID: ${job.id}`,
      `Stage: ${job.current_stage}`,
      `Action required immediately.`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    this.send(job.assigned_to, message);
    await this.markSent(job.id, 'WA_DELAY', job.assigned_to);
  }

  async sendHighRisk(stage: string, managerIds: number[]): Promise<void> {
    const message = [
      `🚨 Production Alert`,
      `Stage: ${stage}`,
      `Workload high. Check dashboard.`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    for (const managerId of managerIds) {
      this.send(managerId, message);
    }
  }

  async sendOrderReady(orderId: number, salesmanId: number): Promise<void> {
    const message = [
      `✅ Order Ready`,
      `Order ID: ${orderId}`,
      `Ready for dispatch.`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    this.send(salesmanId, message);
  }

  sendDailyTaskSummary(
    userId: number,
    summary: { pending: number; inProgress: number; overdue: number },
  ): void {
    const message = [
      `📋 Daily Task Summary`,
      `Pending: ${summary.pending} job(s)`,
      `In progress: ${summary.inProgress} job(s)`,
      summary.overdue > 0
        ? `⚠️ Overdue: ${summary.overdue} job(s)`
        : `All on track ✓`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    this.send(userId, message);
  }

  sendEndOfDayReport(
    userId: number,
    summary: {
      completedToday: number;
      pendingTotal: number;
      userName?: string;
    },
  ): void {
    const { completedToday, pendingTotal, userName } = summary;
    const message = [
      `🌙 End of Day Report${userName ? ` — ${userName}` : ''}`,
      `Completed today: ${completedToday} job(s)`,
      `Pending tomorrow: ${pendingTotal} job(s)`,
      completedToday > 0
        ? `Great effort today!`
        : `Let's aim for more tomorrow.`,
      ``,
      `[${CTX}]`,
    ].join('\n');

    this.send(userId, message);
  }
}

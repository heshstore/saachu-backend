import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationService } from './notification.service';
import { NotificationType, NotificationPriority } from './notification.entity';
import { NOTIFICATION_RULES } from './notification-rules';
import { ProductionJob, ProductionJobStatus, ACTIVE_STATUSES } from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const PRODUCTION_ROLES = new Set([
  'DESIGNER', 'PRINTER', 'LASER_OPERATOR', 'ASSEMBLY_WORKER', 'Production Manager',
]);

@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);

  constructor(
    private readonly notifService: NotificationService,
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly waService: WhatsAppService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Event Handlers ───────────────────────────────────────────────────────────

  @OnEvent('job.assigned')
  async onJobAssigned(job: ProductionJob): Promise<void> {
    if (!job.assigned_to) return;
    const rule = NOTIFICATION_RULES['job.assigned'];

    await this.notifService.createNotification({
      user_id:         job.assigned_to,
      type:            rule.type,
      priority:        rule.priority,
      title:           `New job assigned: Stage ${job.current_stage}`,
      message:         `Job #${job.id} has been assigned to you. Due: ${job.due_date ? new Date(job.due_date).toLocaleDateString() : 'TBD'}`,
      entity_type:     'job',
      entity_id:       job.id,
      cooldownMinutes: rule.cooldownMinutes,
    });
  }

  @OnEvent('job.delayed')
  async onJobDelayed(job: ProductionJob): Promise<void> {
    if (!job.assigned_to) return;
    const rule = NOTIFICATION_RULES['job.delayed'];

    const hoursOverdue = job.due_date
      ? Math.round((Date.now() - new Date(job.due_date).getTime()) / 3_600_000)
      : 0;

    const notif = await this.notifService.createNotification({
      user_id:         job.assigned_to,
      type:            rule.type,
      priority:        rule.priority,
      title:           `Action required: Job #${job.id} is overdue`,
      message:         `Stage ${job.current_stage} is ${hoursOverdue}h overdue. Complete it immediately.`,
      entity_type:     'job',
      entity_id:       job.id,
      cooldownMinutes: rule.cooldownMinutes,
    });

    // WA for HIGH priority — fire-and-forget
    if (notif && rule.sendWhatsApp) {
      this.waService
        .sendToAssignee(
          job.assigned_to,
          `⚠️ Delay Alert\nJob #${job.id} | Stage: ${job.current_stage}\n${hoursOverdue}h overdue. Action required.\n[SYSTEM – PRODUCTION]`,
        )
        .catch(() => {});
    }
  }

  @OnEvent('job.completed')
  async onJobCompleted(job: ProductionJob): Promise<void> {
    // Dismiss all pending notifications for this job
    await this.notifService.clearResolvedNotifications('job', job.id);

    // Info notification to the manager
    const managers = await this.userRepo.find({
      where: { role: 'Production Manager', is_active: true },
      select: ['id'],
    });

    const rule = NOTIFICATION_RULES['job.completed'];
    for (const manager of managers) {
      await this.notifService.createNotification({
        user_id:        manager.id,
        type:           rule.type,
        priority:       rule.priority,
        title:          `Job #${job.id} completed`,
        message:        `Stage ${job.current_stage} completed by worker #${job.assigned_to}.`,
        entity_type:    'job',
        entity_id:      job.id,
        cooldownMinutes: rule.cooldownMinutes,
      });
    }
  }

  @OnEvent('order.created')
  async onOrderCreated(order: { id: number; salesman_id?: number; customer_name?: string }): Promise<void> {
    if (!order.salesman_id) return;
    const rule = NOTIFICATION_RULES['order.created'];

    await this.notifService.createNotification({
      user_id:         order.salesman_id,
      type:            rule.type,
      priority:        rule.priority,
      title:           `New order created`,
      message:         `Order #${order.id} for ${order.customer_name ?? 'customer'} is pending approval.`,
      entity_type:     'order',
      entity_id:       order.id,
      cooldownMinutes: rule.cooldownMinutes,
    });
  }

  @OnEvent('order.completed')
  async onOrderCompleted(payload: { orderId: number; salesmanId?: number }): Promise<void> {
    await this.notifService.clearResolvedNotifications('order', payload.orderId);

    if (!payload.salesmanId) return;
    const rule = NOTIFICATION_RULES['order.completed'];

    await this.notifService.createNotification({
      user_id:         payload.salesmanId,
      type:            rule.type,
      priority:        rule.priority,
      title:           `Order #${payload.orderId} ready for dispatch`,
      message:         `All production stages completed. Order is ready to be dispatched.`,
      entity_type:     'order',
      entity_id:       payload.orderId,
      cooldownMinutes: rule.cooldownMinutes,
    });
  }

  @OnEvent('payment.received')
  async onPaymentReceived(payload: {
    orderId:   number;
    amount:    number;
    createdBy: number;
  }): Promise<void> {
    const rule = NOTIFICATION_RULES['payment.received'];

    // Notify the order creator / salesman via manager chain (use admin id=1 as fallback)
    const managers = await this.userRepo.find({
      where: { role: 'Production Manager', is_active: true },
      select: ['id'],
    });

    const targets = managers.length ? managers.map(m => m.id) : [1];
    for (const userId of targets) {
      await this.notifService.createNotification({
        user_id:         userId,
        type:            rule.type,
        priority:        rule.priority,
        title:           `Payment received`,
        message:         `₹${payload.amount} received for Order #${payload.orderId}.`,
        entity_type:     'payment',
        entity_id:       payload.orderId,
        cooldownMinutes: rule.cooldownMinutes,
      });
    }
  }

  // ── Cron: Delayed Jobs → grouped notification per user+stage ────────────────

  @Cron('*/10 * * * *')
  async checkDelayedJobs(): Promise<void> {
    try {
      const delayed = await this.jobRepo
        .createQueryBuilder('job')
        .where('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.due_date IS NOT NULL')
        .andWhere('job.due_date IS NOT NULL AND job.due_date < :now', { now: new Date() })
        .andWhere('job.assigned_to IS NOT NULL')
        .getMany();

      if (!delayed.length) return;

      // Group by assigned_to + current_stage
      const groups = new Map<string, typeof delayed>();
      for (const job of delayed) {
        const key = `${job.assigned_to}|${job.current_stage}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(job);
      }

      const rule = NOTIFICATION_RULES['job.delayed'];

      for (const [key, jobs] of groups) {
        const [userIdStr, stage] = key.split('|');
        const userId = Number(userIdStr);
        const count  = jobs.length;
        const maxOverdueHours = Math.max(
          ...jobs.map(j =>
            Math.round((Date.now() - new Date(j.due_date!).getTime()) / 3_600_000),
          ),
        );

        // entity_type encodes stage so dedup is unique per user+stage (not just per user)
        const notif = await this.notifService.createNotification({
          user_id:         userId,
          type:            rule.type,
          priority:        rule.priority,
          title:           `${count} job${count > 1 ? 's' : ''} delayed in ${stage}`,
          message:         `Complete them now. Longest overdue: ${maxOverdueHours}h.`,
          entity_type:     `job_group_${stage}`,
          entity_id:       userId,
          cooldownMinutes: rule.cooldownMinutes,
        });

        // One WA message per group, only when notification was not deduped
        if (notif && rule.sendWhatsApp) {
          const jobList = jobs.map(j => `#${j.id}`).join(', ');
          this.waService
            .sendToAssignee(
              userId,
              [
                `⚠️ ${count} Delayed Job${count > 1 ? 's' : ''} — ${stage}`,
                `Jobs: ${jobList}`,
                `Longest overdue: ${maxOverdueHours}h`,
                `Complete them immediately.`,
                `[SYSTEM – PRODUCTION]`,
              ].join('\n'),
            )
            .catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`checkDelayedJobs failed: ${err?.message}`);
    }
  }

  // ── Cron: Idle Users → REMINDER ──────────────────────────────────────────────

  @Cron('0 */2 * * *')
  async checkIdleUsers(): Promise<void> {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

      // Jobs in progress whose started_at is older than 2 hours = worker is idle
      const staleJobs = await this.jobRepo
        .createQueryBuilder('job')
        .where('job.status = :status', { status: ProductionJobStatus.IN_PROGRESS })
        .andWhere('job.assigned_to IS NOT NULL')
        .andWhere('job.started_at < :cutoff', { cutoff: twoHoursAgo })
        .getMany();

      if (!staleJobs.length) return;

      const rule   = NOTIFICATION_RULES['idle_user'];
      const byUser = new Map<number, number>();

      for (const job of staleJobs) {
        byUser.set(job.assigned_to!, (byUser.get(job.assigned_to!) ?? 0) + 1);
      }

      for (const [userId, count] of byUser) {
        await this.notifService.createNotification({
          user_id:         userId,
          type:            rule.type,
          priority:        rule.priority,
          title:           'Pending work waiting',
          message:         `You have ${count} job(s) in progress with no recent activity. Please update your progress.`,
          entity_type:     'user',
          entity_id:       userId,
          cooldownMinutes: rule.cooldownMinutes,
        });
      }
    } catch (err: any) {
      this.logger.error(`checkIdleUsers failed: ${err?.message}`);
    }
  }

  // ── Cron: End-of-Day Summary @ 19:00 ────────────────────────────────────────

  @Cron('0 19 * * *')
  async endOfDaySummary(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const productionUsers = await this.userRepo
        .createQueryBuilder('u')
        .where('u.is_active = true')
        .andWhere('u.role IN (:...roles)', { roles: [...PRODUCTION_ROLES] })
        .getMany();

      const rule = NOTIFICATION_RULES['end_of_day'];

      for (const user of productionUsers) {
        const [completedToday, pendingTotal] = await Promise.all([
          this.jobRepo.count({
            where: {
              assigned_to: user.id,
              status:      ProductionJobStatus.DONE,
              completed_at: MoreThan(today),
            },
          }),
          this.jobRepo.count({
            where: {
              assigned_to: user.id,
              status:      In(ACTIVE_STATUSES),
            },
          }),
        ]);

        await this.notifService.createNotification({
          user_id:        user.id,
          type:           rule.type,
          priority:       rule.priority,
          title:          completedToday > 0 ? `Great work today! ${completedToday} job(s) done` : 'Daily summary',
          message:        `Completed: ${completedToday} job(s). Pending for tomorrow: ${pendingTotal}.`,
          entity_type:    null,
          entity_id:      null,
          cooldownMinutes: rule.cooldownMinutes,
        });

        if (rule.sendWhatsApp && (user.role === 'Production Manager' || completedToday > 0)) {
          this.sendEndOfDayReport(user.id, { completedToday, pendingTotal, userName: user.name });
        }
      }
    } catch (err: any) {
      this.logger.error(`endOfDaySummary failed: ${err?.message}`);
    }
  }

  // ── Cron: Nightly Cleanup @ 02:00 ───────────────────────────────────────────

  @Cron('0 2 * * *')
  async cleanupNotifications(): Promise<void> {
    try {
      const removed = await this.notifService.deleteExpiredAndInactive();
      this.logger.log(`Cleanup: removed ${removed} expired/inactive notifications`);
    } catch (err: any) {
      this.logger.error(`cleanupNotifications failed: ${err?.message}`);
    }
  }

  // ── WhatsApp Helpers (fire-and-forget) ───────────────────────────────────────

  sendDailyTaskSummary(userId: number, jobs: ProductionJob[]): void {
    const pending   = jobs.filter(j => j.status === ProductionJobStatus.PENDING).length;
    const inProgress = jobs.filter(j => j.status === ProductionJobStatus.IN_PROGRESS).length;
    const overdue   = jobs.filter(j => j.due_date && new Date() > new Date(j.due_date)).length;

    const message = [
      `📋 Daily Task Summary`,
      `Pending: ${pending} job(s)`,
      `In progress: ${inProgress} job(s)`,
      overdue > 0 ? `⚠️ Overdue: ${overdue} job(s)` : `All on track ✓`,
      `[SYSTEM – PRODUCTION]`,
    ].join('\n');

    this.waService.sendToAssignee(userId, message).catch(() => {});
  }

  sendEndOfDayReport(
    userId: number,
    summary: { completedToday: number; pendingTotal: number; userName?: string },
  ): void {
    const { completedToday, pendingTotal, userName } = summary;
    const message = [
      `🌙 End of Day Report${userName ? ` — ${userName}` : ''}`,
      `Jobs completed today: ${completedToday}`,
      `Jobs pending tomorrow: ${pendingTotal}`,
      completedToday > 0 ? `Great effort today! Keep it up.` : `Let's aim for more tomorrow!`,
      `[SYSTEM – PRODUCTION]`,
    ].join('\n');

    this.waService.sendToAssignee(userId, message).catch(() => {});
  }
}

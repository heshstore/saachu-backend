import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationService } from './notification.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from './notification.entity';
import { NOTIFICATION_RULES } from './notification-rules';
import {
  ProductionJob,
  ProductionJobStatus,
  ACTIVE_STATUSES,
} from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';
import { CrmWhatsAppService } from '../crm-whatsapp/crm-whatsapp.service';
import { DbHealthService } from '../shared/db-health.service';

const PRODUCTION_ROLES = new Set([
  'DESIGNER',
  'PRINTER',
  'LASER_OPERATOR',
  'ASSEMBLY_WORKER',
  'Production Manager',
]);

@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);
  private _running = false;

  constructor(
    private readonly notifService: NotificationService,
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly waService: CrmWhatsAppService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dbHealth: DbHealthService,
  ) {}

  // ── System: WhatsApp down ────────────────────────────────────────────────────

  @OnEvent('crm.whatsapp.down')
  async onWhatsAppDown(payload: { reason: string }): Promise<void> {
    try {
      const isCritical = ['AUTH_FAILURE', 'CONFLICT'].includes(payload.reason);
      await this.notifService.createRoleNotification(['Admin'], {
        type: NotificationType.ACTION,
        priority: isCritical
          ? NotificationPriority.CRITICAL
          : NotificationPriority.HIGH,
        category: NotificationCategory.SYSTEM,
        title: isCritical
          ? 'WhatsApp disconnected — action required'
          : 'WhatsApp connection lost',
        message: `Reason: ${payload.reason}. ${
          isCritical
            ? 'Re-authentication is required on the WhatsApp admin page.'
            : 'Check the WhatsApp monitor to reconnect.'
        }`,
        action_url: '/admin/whatsapp',
        cooldownMinutes: 15,
        is_automated: true,
      });
    } catch (err: any) {
      this.logger.warn(`onWhatsAppDown notification failed: ${err?.message}`);
    }
  }

  // ── Production: job events ───────────────────────────────────────────────────

  @OnEvent('job.assigned')
  async onJobAssigned(job: ProductionJob): Promise<void> {
    if (!job.assigned_to) return;
    const rule = NOTIFICATION_RULES['job.assigned'];
    await this.notifService.createNotification({
      user_id: job.assigned_to,
      type: rule.type,
      priority: rule.priority,
      category: NotificationCategory.PRODUCTION,
      title: `New job assigned: Stage ${job.current_stage}`,
      message: `Job #${job.id} has been assigned to you. Due: ${job.due_date ? new Date(job.due_date).toLocaleDateString() : 'TBD'}`,
      entity_type: 'job',
      entity_id: job.id,
      action_url: `/production/jobs/${job.id}`,
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
      user_id: job.assigned_to,
      type: rule.type,
      priority: rule.priority,
      category: NotificationCategory.PRODUCTION,
      title: `Action required: Job #${job.id} is overdue`,
      message: `Stage ${job.current_stage} is ${hoursOverdue}h overdue. Complete it immediately.`,
      entity_type: 'job',
      entity_id: job.id,
      action_url: `/production/jobs/${job.id}`,
      cooldownMinutes: rule.cooldownMinutes,
    });

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
    const managers = await this.userRepo.find({
      where: { role: 'Production Manager', is_active: true },
      select: ['id'],
    });
    const rule = NOTIFICATION_RULES['job.completed'];
    for (const manager of managers) {
      await this.notifService.createNotification({
        user_id: manager.id,
        type: rule.type,
        priority: rule.priority,
        category: NotificationCategory.PRODUCTION,
        title: `Job #${job.id} completed`,
        message: `Stage ${job.current_stage} completed by worker #${job.assigned_to}.`,
        entity_type: 'job',
        entity_id: job.id,
        action_url: `/production/jobs/${job.id}`,
        cooldownMinutes: rule.cooldownMinutes,
      });
    }
  }

  // ── CRM: lead assigned ───────────────────────────────────────────────────────

  @OnEvent('crm.lead.assigned')
  async onLeadAssigned(payload: {
    id: number;
    name: string;
    assigned_to: number;
    assigned_to_name?: string;
    assigned_by_id?: number;
    assigned_by_name?: string;
  }): Promise<void> {
    if (!payload.assigned_to) return;
    try {
      await this.notifService.createNotification({
        user_id: payload.assigned_to,
        type: NotificationType.ACTION,
        priority: NotificationPriority.HIGH,
        category: NotificationCategory.CRM,
        title: `Lead assigned: ${payload.name}`,
        message: payload.assigned_by_name
          ? `Assigned to you by ${payload.assigned_by_name}. Follow up promptly.`
          : `A new lead has been assigned to you. Follow up promptly.`,
        entity_type: 'lead',
        entity_id: payload.id,
        action_url: `/crm/leads/${payload.id}`,
        cooldownMinutes: 10,
        is_automated: true,
      });
    } catch (err: any) {
      this.logger.warn(`onLeadAssigned notification failed: ${err?.message}`);
    }
  }

  // ── System: Shopify sync failure ─────────────────────────────────────────────

  @OnEvent('shopify.sync_failed')
  async onShopifySyncFailed(payload: { error: string }): Promise<void> {
    try {
      await this.notifService.createRoleNotification(['Admin'], {
        type: NotificationType.ACTION,
        priority: NotificationPriority.HIGH,
        category: NotificationCategory.SYSTEM,
        title: 'Shopify sync failed',
        message: `Catalog sync encountered an error: ${payload.error?.slice(0, 120) ?? 'Unknown error'}. Check the Shopify integration.`,
        action_url: '/admin/shopify',
        cooldownMinutes: 60,
        is_automated: true,
      });
    } catch (err: any) {
      this.logger.warn(
        `onShopifySyncFailed notification failed: ${err?.message}`,
      );
    }
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  @OnEvent('order.created')
  async onOrderCreated(order: {
    id: number;
    salesman_id?: number;
    customer_name?: string;
  }): Promise<void> {
    if (!order.salesman_id) return;
    const rule = NOTIFICATION_RULES['order.created'];
    await this.notifService.createNotification({
      user_id: order.salesman_id,
      type: rule.type,
      priority: rule.priority,
      category: NotificationCategory.PRODUCTION,
      title: `New order created`,
      message: `Order #${order.id} for ${order.customer_name ?? 'customer'} is pending approval.`,
      entity_type: 'order',
      entity_id: order.id,
      action_url: `/orders/${order.id}`,
      cooldownMinutes: rule.cooldownMinutes,
    });
  }

  @OnEvent('order.completed')
  async onOrderCompleted(payload: {
    orderId: number;
    salesmanId?: number;
  }): Promise<void> {
    if (!payload.salesmanId) return;
    const rule = NOTIFICATION_RULES['order.completed'];
    await this.notifService.createNotification({
      user_id: payload.salesmanId,
      type: rule.type,
      priority: rule.priority,
      category: NotificationCategory.DISPATCH,
      title: `Order #${payload.orderId} ready for dispatch`,
      message: `All production stages completed. Order is ready to be dispatched.`,
      entity_type: 'order',
      entity_id: payload.orderId,
      action_url: `/dispatch`,
      cooldownMinutes: rule.cooldownMinutes,
    });
  }

  @OnEvent('payment.received')
  async onPaymentReceived(payload: {
    orderId: number;
    amount: number;
    createdBy: number;
  }): Promise<void> {
    const rule = NOTIFICATION_RULES['payment.received'];
    const managers = await this.userRepo.find({
      where: { role: 'Production Manager', is_active: true },
      select: ['id'],
    });
    const targets = managers.length ? managers.map((m) => m.id) : [1];
    for (const userId of targets) {
      await this.notifService.createNotification({
        user_id: userId,
        type: rule.type,
        priority: rule.priority,
        category: NotificationCategory.ACCOUNTS,
        title: `Payment received`,
        message: `₹${payload.amount} received for Order #${payload.orderId}.`,
        entity_type: 'payment',
        entity_id: payload.orderId,
        action_url: `/accounts/history/${payload.orderId}`,
        cooldownMinutes: rule.cooldownMinutes,
      });
    }
  }

  // ── Cron: Delayed jobs (every 10 min) ────────────────────────────────────────

  @Cron('*/10 * * * *')
  async checkDelayedJobs(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const delayed = await this.jobRepo
        .createQueryBuilder('job')
        .where('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.due_date IS NOT NULL AND job.due_date < :now', {
          now: new Date(),
        })
        .andWhere('job.assigned_to IS NOT NULL')
        .getMany();

      if (!delayed.length) return;

      const groups = new Map<string, typeof delayed>();
      for (const job of delayed) {
        const key = `${job.assigned_to}|${job.current_stage}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
      }

      const rule = NOTIFICATION_RULES['job.delayed'];

      for (const [key, jobs] of groups) {
        const [userIdStr, stage] = key.split('|');
        const userId = Number(userIdStr);
        const count = jobs.length;
        const maxOverdueHours = Math.max(
          ...jobs.map((j) =>
            Math.round(
              (Date.now() - new Date(j.due_date).getTime()) / 3_600_000,
            ),
          ),
        );

        const notif = await this.notifService.createNotification({
          user_id: userId,
          type: rule.type,
          priority: rule.priority,
          category: NotificationCategory.PRODUCTION,
          title: `${count} job${count > 1 ? 's' : ''} delayed in ${stage}`,
          message: `Complete them now. Longest overdue: ${maxOverdueHours}h.`,
          entity_type: `job_group_${stage}`,
          entity_id: userId,
          action_url: '/production/queue',
          cooldownMinutes: rule.cooldownMinutes,
        });

        if (notif && rule.sendWhatsApp) {
          const jobList = jobs.map((j) => `#${j.id}`).join(', ');
          this.waService
            .sendToAssignee(
              userId,
              [
                `⚠️ ${count} Delayed Job${count > 1 ? 's' : ''} — ${stage}`,
                `Jobs: ${jobList}`,
                `Longest overdue: ${maxOverdueHours}h`,
                `[SYSTEM – PRODUCTION]`,
              ].join('\n'),
            )
            .catch(() => {});
        }
      }
    } catch (err: any) {
      this.dbHealth.handleError(err, 'NotificationEngine.checkDelayedJobs');
    } finally {
      this._running = false;
    }
  }

  // ── Cron: Hot CRM leads uncontacted (every 4h during business hours) ─────────

  @Cron('0 */4 8-20 * * *')
  async checkHotLeads(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      // Raw SQL to avoid hard-coupling Lead entity into this module.
      // Fails silently if table/column structure differs.
      const rows: Array<{ assigned_to: number; id: number; name: string }> =
        await this.userRepo.manager.query(`
          SELECT assigned_to, id, name
          FROM leads
          WHERE lead_priority = 'HIGH'
            AND is_active = true
            AND status NOT IN ('CONVERTED', 'LOST')
            AND assigned_to IS NOT NULL
          LIMIT 100
        `);

      if (!rows.length) return;

      const byUser = new Map<number, typeof rows>();
      for (const row of rows) {
        if (!byUser.has(row.assigned_to)) byUser.set(row.assigned_to, []);
        byUser.get(row.assigned_to).push(row);
      }

      for (const [userId, leads] of byUser) {
        const count = leads.length;
        await this.notifService.createNotification({
          user_id: userId,
          type: NotificationType.ACTION,
          priority: NotificationPriority.HIGH,
          category: NotificationCategory.CRM,
          title: `${count} HOT lead${count > 1 ? 's' : ''} need follow-up`,
          message:
            count === 1
              ? `"${leads[0].name}" is a hot lead awaiting your contact.`
              : `${count} hot leads are waiting for follow-up. Act now to convert them.`,
          entity_type: count === 1 ? 'lead' : null,
          entity_id: count === 1 ? leads[0].id : null,
          action_url:
            count === 1 ? `/crm/leads/${leads[0].id}` : '/crm/leads?filter=hot',
          cooldownMinutes: 240,
          is_automated: true,
        });
      }
    } catch (err: any) {
      this.dbHealth.handleError(err, 'NotificationEngine.checkHotLeads');
    } finally {
      this._running = false;
    }
  }

  // ── Cron: Idle workers (every 2h) ────────────────────────────────────────────

  @Cron('0 */2 * * *')
  async checkIdleUsers(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      const staleJobs = await this.jobRepo
        .createQueryBuilder('job')
        .where('job.status = :status', {
          status: ProductionJobStatus.IN_PROGRESS,
        })
        .andWhere('job.assigned_to IS NOT NULL')
        .andWhere('job.started_at < :cutoff', { cutoff: twoHoursAgo })
        .getMany();

      if (!staleJobs.length) return;

      const rule = NOTIFICATION_RULES['idle_user'];
      const byUser = new Map<number, number>();
      for (const job of staleJobs) {
        byUser.set(job.assigned_to, (byUser.get(job.assigned_to) ?? 0) + 1);
      }

      for (const [userId, count] of byUser) {
        await this.notifService.createNotification({
          user_id: userId,
          type: rule.type,
          priority: rule.priority,
          category: NotificationCategory.PRODUCTION,
          title: 'Pending work waiting',
          message: `You have ${count} job(s) in progress with no recent activity.`,
          entity_type: 'user',
          entity_id: userId,
          action_url: '/production/my-jobs',
          cooldownMinutes: rule.cooldownMinutes,
        });
      }
    } catch (err: any) {
      this.dbHealth.handleError(err, 'NotificationEngine.checkIdleUsers');
    } finally {
      this._running = false;
    }
  }

  // ── Cron: End-of-Day Summary @ 19:00 ────────────────────────────────────────

  @Cron('0 19 * * *')
  async endOfDaySummary(): Promise<void> {
    if (this._running) return;
    this._running = true;
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
            where: { assigned_to: user.id, status: ProductionJobStatus.DONE },
          }),
          this.jobRepo.count({
            where: { assigned_to: user.id, status: In(ACTIVE_STATUSES) },
          }),
        ]);

        await this.notifService.createNotification({
          user_id: user.id,
          type: rule.type,
          priority: rule.priority,
          category: NotificationCategory.PRODUCTION,
          title:
            completedToday > 0
              ? `Great work today! ${completedToday} job(s) done`
              : 'Daily summary',
          message: `Completed: ${completedToday}. Pending for tomorrow: ${pendingTotal}.`,
          entity_type: null,
          entity_id: null,
          cooldownMinutes: rule.cooldownMinutes,
        });

        if (
          rule.sendWhatsApp &&
          (user.role === 'Production Manager' || completedToday > 0)
        ) {
          this.sendEndOfDayReport(user.id, {
            completedToday,
            pendingTotal,
            userName: user.name,
          });
        }
      }
    } catch (err: any) {
      this.dbHealth.handleError(err, 'NotificationEngine.endOfDaySummary');
    } finally {
      this._running = false;
    }
  }

  // ── WhatsApp helpers (fire-and-forget) ───────────────────────────────────────

  sendDailyTaskSummary(userId: number, jobs: ProductionJob[]): void {
    const pending = jobs.filter(
      (j) => j.status === ProductionJobStatus.PENDING,
    ).length;
    const inProgress = jobs.filter(
      (j) => j.status === ProductionJobStatus.IN_PROGRESS,
    ).length;
    const overdue = jobs.filter(
      (j) => j.due_date && new Date() > new Date(j.due_date),
    ).length;
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
    summary: {
      completedToday: number;
      pendingTotal: number;
      userName?: string;
    },
  ): void {
    const { completedToday, pendingTotal, userName } = summary;
    const message = [
      `🌙 End of Day Report${userName ? ` — ${userName}` : ''}`,
      `Jobs completed today: ${completedToday}`,
      `Jobs pending tomorrow: ${pendingTotal}`,
      completedToday > 0
        ? `Great effort today! Keep it up.`
        : `Let's aim for more tomorrow!`,
      `[SYSTEM – PRODUCTION]`,
    ].join('\n');
    this.waService.sendToAssignee(userId, message).catch(() => {});
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThan } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Notification, NotificationType, NotificationPriority, PRIORITY_RANK } from './notification.entity';
import { ProductionJob, ProductionJobStatus, ACTIVE_STATUSES } from '../orders/entities/production-job.entity';

const MAX_ACTIVE_PER_USER = 5;

export interface CreateNotificationPayload {
  user_id:          number;
  type:             NotificationType;
  priority:         NotificationPriority;
  title:            string;
  message:          string;
  entity_type?:     string | null;
  entity_id?:       number | null;
  cooldownMinutes?: number;
  is_automated?:    boolean;
}

export interface NextBestAction {
  action:    'COMPLETE_DELAYED' | 'START_URGENT' | 'START_NEXT' | 'ALL_CLEAR';
  message:   string;
  job_id?:   number;
  order_id?: number;
  stage?:    string;
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.repo.manager.query(
        `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    } catch (e) {
      this.logger.error('Failed to ensure notifications.is_automated column', e);
    }
  }

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Core: create with dedup + cooldown + limit ───────────────────────────────

  async createNotification(payload: CreateNotificationPayload): Promise<Notification | null> {
    const { user_id, entity_type, entity_id, type, cooldownMinutes = 30 } = payload;

    // Dedup: same (user, entity_type, entity_id, type) within cooldown window
    if (entity_type && entity_id) {
      const cutoff   = new Date(Date.now() - cooldownMinutes * 60_000);
      const existing = await this.repo.findOne({
        where: { user_id, entity_type, entity_id, type, is_active: true, created_at: MoreThan(cutoff) },
      });
      if (existing) {
        this.logger.debug(`Dedup: skipping ${type} for entity=${entity_type}:${entity_id} user=${user_id}`);
        return null;
      }
    }

    // Enforce max active notifications per user
    await this.enforceLimit(user_id, payload.priority);

    const expires_at = this.getExpiry(type);

    const notif = this.repo.create({
      user_id,
      type,
      priority:     payload.priority,
      title:        payload.title,
      message:      payload.message,
      entity_type:  entity_type ?? null,
      entity_id:    entity_id  ?? null,
      is_automated: payload.is_automated ?? false,
      expires_at,
    });

    const saved = await this.repo.save(notif);
    this.eventEmitter.emit('notification.created', { userId: user_id, notification: saved });
    return saved;
  }

  private getExpiry(type: NotificationType): Date {
    const HOURS: Record<NotificationType, number> = {
      [NotificationType.ACTION]:     24,
      [NotificationType.REMINDER]:    6,
      [NotificationType.INFO]:        12,
      [NotificationType.MOTIVATION]: 24,
    };
    return new Date(Date.now() + HOURS[type] * 3_600_000);
  }

  // Drop the lowest-priority oldest notification when the per-user limit is reached.
  // Single query: count active, find eviction candidate, deactivate — no JS sort.
  private async enforceLimit(userId: number, incomingPriority: NotificationPriority): Promise<void> {
    const count = await this.repo.count({ where: { user_id: userId, is_active: true } });
    if (count < MAX_ACTIVE_PER_USER) return;

    // Find the lowest-priority, oldest notification in one query.
    const [lowest]: Array<{ id: string; priority: NotificationPriority }> =
      await this.repo.manager.query(
        `SELECT id, priority FROM notifications
         WHERE user_id = $1 AND is_active = true
         ORDER BY
           CASE priority WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END ASC,
           created_at ASC
         LIMIT 1`,
        [userId],
      );

    if (!lowest) return;
    if (PRIORITY_RANK[incomingPriority] <= PRIORITY_RANK[lowest.priority]) return;

    await this.repo.update(lowest.id, { is_active: false });
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async getUserNotifications(userId: number): Promise<Notification[]> {
    const now = new Date();
    return this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.is_active = true')
      .andWhere('(n.expires_at IS NULL OR n.expires_at > :now)', { now })
      .orderBy(
        `CASE n.priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`,
        'ASC',
      )
      .addOrderBy('n.created_at', 'DESC')
      .take(50)
      .getMany();
  }

  async getUnreadCount(userId: number): Promise<number> {
    const now = new Date();
    return this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.is_active = true')
      .andWhere('n.is_read = false')
      .andWhere('(n.expires_at IS NULL OR n.expires_at > :now)', { now })
      .getCount();
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async markAsRead(notificationId: string, userId: number): Promise<void> {
    await this.repo.update({ id: notificationId, user_id: userId }, { is_read: true });
  }

  async markAllRead(userId: number): Promise<void> {
    await this.repo.update({ user_id: userId, is_active: true }, { is_read: true });
  }

  // Called when a job/order is completed — dismiss its related notifications
  async clearResolvedNotifications(entityType: string, entityId: number): Promise<void> {
    await this.repo.update(
      { entity_type: entityType, entity_id: entityId, is_active: true },
      { is_active: false },
    );
  }

  async deleteExpiredAndInactive(): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('is_active = false OR expires_at < NOW()')
      .execute();
    return result.affected ?? 0;
  }

  // ── Contextual Prompt ────────────────────────────────────────────────────────

  async getNextBestAction(userId: number): Promise<NextBestAction> {
    const now = new Date();

    const [delayedJob, urgentJob, pendingJob] = await Promise.all([
      // 1. Overdue: due_date passed and status is active
      this.jobRepo
        .createQueryBuilder('job')
        .where('job.assigned_to = :userId', { userId })
        .andWhere('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.due_date IS NOT NULL')
        .andWhere('job.due_date IS NOT NULL AND job.due_date < :now', { now })
        .orderBy('job.due_date', 'ASC')
        .getOne(),

      // 2. Urgent: HIGH or URGENT priority and status is active
      this.jobRepo
        .createQueryBuilder('job')
        .where('job.assigned_to = :userId', { userId })
        .andWhere('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.priority IN (:...urgent)', { urgent: ['HIGH', 'URGENT'] })
        .orderBy('job.created_at', 'ASC')
        .getOne(),

      // 3. Next: any active job
      this.jobRepo
        .createQueryBuilder('job')
        .where('job.assigned_to = :userId', { userId })
        .andWhere('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .orderBy('job.created_at', 'ASC')
        .getOne(),
    ]);

    if (delayedJob) {
      return {
        action:   'COMPLETE_DELAYED',
        message:  `Complete delayed job #${delayedJob.id} — ${delayedJob.current_stage} stage is overdue`,
        job_id:   delayedJob.id,
        order_id: delayedJob.order_id,
        stage:    delayedJob.current_stage,
      };
    }

    if (urgentJob) {
      return {
        action:   'START_URGENT',
        message:  `Start urgent job #${urgentJob.id} — ${urgentJob.current_stage} stage (${urgentJob.priority})`,
        job_id:   urgentJob.id,
        order_id: urgentJob.order_id,
        stage:    urgentJob.current_stage,
      };
    }

    if (pendingJob) {
      return {
        action:   'START_NEXT',
        message:  `Start next job #${pendingJob.id} — ${pendingJob.current_stage} stage`,
        job_id:   pendingJob.id,
        order_id: pendingJob.order_id,
        stage:    pendingJob.current_stage,
      };
    }

    return {
      action:  'ALL_CLEAR',
      message: 'All caught up! No pending jobs assigned to you.',
    };
  }
}

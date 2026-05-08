import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Notification,
  NotificationType,
  NotificationPriority,
  NotificationCategory,
  PRIORITY_RANK,
} from './notification.entity';
import { ProductionJob, ACTIVE_STATUSES } from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';

const MAX_ACTIVE_PER_USER = 15;
const CENTER_PAGE_SIZE    = 20;

export interface CreateNotificationPayload {
  user_id:          number;
  type:             NotificationType;
  priority:         NotificationPriority;
  title:            string;
  message:          string;
  category?:        NotificationCategory | string | null;
  entity_type?:     string | null;
  entity_id?:       number | null;
  action_url?:      string | null;
  role_targets?:    string[] | null;
  metadata?:        Record<string, any> | null;
  cooldownMinutes?: number;
  is_automated?:    boolean;
}

export interface CenterFilters {
  unread?:   boolean;
  category?: string;
  priority?: string;
  page?:     number;
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

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Runtime column migrations ────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    const migrations = [
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category    VARCHAR(20)`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url  VARCHAR(500)`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS role_targets TEXT`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata     JSONB`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS hidden_at    TIMESTAMPTZ`,
    ];
    for (const sql of migrations) {
      try {
        await this.repo.manager.query(sql);
      } catch (e: any) {
        this.logger.warn(`Migration skipped: ${e?.message?.slice(0, 80)}`);
      }
    }
  }

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
        this.logger.debug(`Dedup: skipping ${type} for ${entity_type}:${entity_id} user=${user_id}`);
        return null;
      }
    }

    await this.enforceLimit(user_id, payload.priority);

    const notif = this.repo.create({
      user_id,
      type,
      priority:     payload.priority,
      category:     (payload.category as NotificationCategory) ?? null,
      title:        payload.title,
      message:      payload.message,
      entity_type:  entity_type ?? null,
      entity_id:    entity_id  ?? null,
      action_url:   payload.action_url ?? null,
      role_targets: payload.role_targets ?? null,
      metadata:     payload.metadata ?? null,
      is_automated: payload.is_automated ?? false,
      expires_at:   this.getExpiry(type),
    });

    const saved = await this.repo.save(notif);
    this.eventEmitter.emit('notification.created', { userId: user_id, notification: saved });
    return saved;
  }

  // Fan-out: create one notification per user matching any of the given roles
  async createRoleNotification(
    roles: string[],
    payload: Omit<CreateNotificationPayload, 'user_id'>,
  ): Promise<void> {
    if (!roles.length) return;
    const users = await this.userRepo.find({
      where: roles.map(role => ({ role, is_active: true })),
      select: ['id'],
    });
    for (const user of users) {
      await this.createNotification({ ...payload, user_id: user.id, role_targets: roles });
    }
  }

  private getExpiry(type: NotificationType): Date {
    const HOURS: Record<NotificationType, number> = {
      [NotificationType.ACTION]:     48,
      [NotificationType.REMINDER]:    6,
      [NotificationType.INFO]:       24,
      [NotificationType.MOTIVATION]: 24,
    };
    return new Date(Date.now() + HOURS[type] * 3_600_000);
  }

  // Drop the lowest-priority oldest when per-user limit is reached.
  // CRITICAL notifications are never evicted (weight = 99 in ORDER BY).
  private async enforceLimit(userId: number, incomingPriority: NotificationPriority): Promise<void> {
    const count = await this.repo.count({ where: { user_id: userId, is_active: true } });
    if (count < MAX_ACTIVE_PER_USER) return;

    const [lowest]: Array<{ id: string; priority: NotificationPriority }> =
      await this.repo.manager.query(
        `SELECT id, priority FROM notifications
         WHERE user_id = $1 AND is_active = true
         ORDER BY
           CASE priority
             WHEN 'CRITICAL' THEN 99
             WHEN 'HIGH'     THEN 3
             WHEN 'MEDIUM'   THEN 2
             ELSE 1
           END ASC,
           created_at ASC
         LIMIT 1`,
        [userId],
      );

    if (!lowest) return;
    if (PRIORITY_RANK[incomingPriority] <= PRIORITY_RANK[lowest.priority]) return;

    await this.repo.update(lowest.id, { is_active: false });
  }

  // ── Panel query (existing behavior preserved) ────────────────────────────────

  async getUserNotifications(userId: number): Promise<Notification[]> {
    const now = new Date();
    return this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.is_active = true')
      .andWhere('n.hidden_at IS NULL')
      .andWhere('(n.expires_at IS NULL OR n.expires_at > :now)', { now })
      .orderBy(
        `CASE n.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`,
        'ASC',
      )
      .addOrderBy('n.created_at', 'DESC')
      .take(50)
      .getMany();
  }

  // ── Notification Center query (paginated, filtered, includes all non-hidden) ─

  async getNotificationsForCenter(
    userId: number,
    filters: CenterFilters,
  ): Promise<{ items: Notification[]; total: number; page: number }> {
    const { unread, category, priority, page = 1 } = filters;
    const now = new Date();

    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.hidden_at IS NULL')
      .andWhere('(n.expires_at IS NULL OR n.expires_at > :now)', { now });

    if (unread) qb.andWhere('n.is_read = false');
    if (category) qb.andWhere('n.category = :category', { category });
    if (priority) qb.andWhere('n.priority = :priority', { priority });

    const total = await qb.getCount();

    qb.orderBy('CASE WHEN n.is_read = false THEN 0 ELSE 1 END', 'ASC')
      .addOrderBy(
        `CASE n.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END`,
        'ASC',
      )
      .addOrderBy('n.created_at', 'DESC')
      .skip((page - 1) * CENTER_PAGE_SIZE)
      .take(CENTER_PAGE_SIZE);

    const items = await qb.getMany();
    return { items, total, page };
  }

  // ── Counts ───────────────────────────────────────────────────────────────────

  async getUnreadCount(userId: number): Promise<number> {
    const now = new Date();
    return this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.is_active = true')
      .andWhere('n.is_read = false')
      .andWhere('n.hidden_at IS NULL')
      .andWhere('(n.expires_at IS NULL OR n.expires_at > :now)', { now })
      .getCount();
  }

  async getCountByCategory(userId: number): Promise<{ total: number; byCategory: Record<string, number> }> {
    const now = new Date();
    const rows: Array<{ category: string | null; cnt: string }> = await this.repo.manager.query(
      `SELECT category, COUNT(*) as cnt
       FROM notifications
       WHERE user_id = $1
         AND is_read = false
         AND hidden_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)
       GROUP BY category`,
      [userId, now],
    );

    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.cnt);
      total += count;
      const key = row.category ?? 'OTHER';
      byCategory[key] = (byCategory[key] ?? 0) + count;
    }
    return { total, byCategory };
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async markAsRead(notificationId: string, userId: number): Promise<void> {
    await this.repo.update({ id: notificationId, user_id: userId }, { is_read: true });
  }

  async markAllRead(userId: number): Promise<void> {
    await this.repo.update({ user_id: userId }, { is_read: true });
  }

  async hideNotification(id: string, userId: number): Promise<void> {
    await this.repo.update({ id, user_id: userId }, { hidden_at: new Date() });
  }

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
      this.jobRepo
        .createQueryBuilder('job')
        .where('job.assigned_to = :userId', { userId })
        .andWhere('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.due_date IS NOT NULL AND job.due_date < :now', { now })
        .orderBy('job.due_date', 'ASC')
        .getOne(),
      this.jobRepo
        .createQueryBuilder('job')
        .where('job.assigned_to = :userId', { userId })
        .andWhere('job.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
        .andWhere('job.priority IN (:...urgent)', { urgent: ['HIGH', 'URGENT'] })
        .orderBy('job.created_at', 'ASC')
        .getOne(),
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
    return { action: 'ALL_CLEAR', message: 'All caught up! No pending jobs assigned to you.' };
  }
}

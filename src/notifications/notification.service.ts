import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from './notification.entity';
import {
  ProductionJob,
  ACTIVE_STATUSES,
} from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';

// Push-only notifications: no DB storage, no in-app history. createNotification()
// just dedups in-memory and emits the event PushService listens on.
export interface NotificationPayload {
  user_id: number;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  category?: NotificationCategory | string | null;
  entity_type?: string | null;
  entity_id?: number | null;
  action_url?: string | null;
  role_targets?: string[] | null;
  metadata?: Record<string, any> | null;
  is_automated?: boolean;
}

export interface CreateNotificationPayload extends NotificationPayload {
  cooldownMinutes?: number;
}

export interface NextBestAction {
  action: 'COMPLETE_DELAYED' | 'START_URGENT' | 'START_NEXT' | 'ALL_CLEAR';
  message: string;
  job_id?: number;
  order_id?: number;
  stage?: string;
}

const DEDUP_TTL_MS = 24 * 3_600_000; // prune in-memory dedup keys older than this

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  // Replaces the old DB-backed (user_id, entity_type, entity_id, type) dedup —
  // same cooldown behavior, just process-local instead of Postgres-backed.
  private readonly _recentKeys = new Map<string, number>();

  constructor(
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Core: create with in-memory dedup + cooldown ─────────────────────────────

  async createNotification(
    payload: CreateNotificationPayload,
  ): Promise<NotificationPayload | null> {
    const { user_id, entity_type, entity_id, type, cooldownMinutes = 30 } =
      payload;

    if (entity_type && entity_id) {
      const key = `${user_id}:${entity_type}:${entity_id}:${type}`;
      const cutoff = Date.now() - cooldownMinutes * 60_000;
      const last = this._recentKeys.get(key);
      if (last && last > cutoff) {
        this.logger.debug(
          `Dedup: skipping ${type} for ${entity_type}:${entity_id} user=${user_id}`,
        );
        return null;
      }
      this._recentKeys.set(key, Date.now());
      this._pruneDedupKeys();
    }

    const notif: NotificationPayload = {
      user_id,
      type,
      priority: payload.priority,
      category: (payload.category as NotificationCategory) ?? null,
      title: payload.title,
      message: payload.message,
      entity_type: entity_type ?? null,
      entity_id: entity_id ?? null,
      action_url: payload.action_url ?? null,
      role_targets: payload.role_targets ?? null,
      metadata: payload.metadata ?? null,
      is_automated: payload.is_automated ?? false,
    };

    this.eventEmitter.emit('notification.created', {
      userId: user_id,
      notification: notif,
    });
    return notif;
  }

  // Fan-out: create one notification per user matching any of the given roles
  async createRoleNotification(
    roles: string[],
    payload: Omit<CreateNotificationPayload, 'user_id'>,
  ): Promise<void> {
    if (!roles.length) return;
    const users = await this.userRepo.find({
      where: roles.map((role) => ({ role, is_active: true })),
      select: ['id'],
    });
    for (const user of users) {
      await this.createNotification({
        ...payload,
        user_id: user.id,
        role_targets: roles,
      });
    }
  }

  private _pruneDedupKeys(): void {
    if (this._recentKeys.size < 5000) return; // cheap size check before scanning
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, t] of this._recentKeys) {
      if (t < cutoff) this._recentKeys.delete(k);
    }
  }

  // ── Contextual Prompt ────────────────────────────────────────────────────────
  // Reads live ProductionJob state directly — not backed by notification storage.

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
        .andWhere('job.priority IN (:...urgent)', {
          urgent: ['HIGH', 'URGENT'],
        })
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
        action: 'COMPLETE_DELAYED',
        message: `Complete delayed job #${delayedJob.id} — ${delayedJob.current_stage} stage is overdue`,
        job_id: delayedJob.id,
        order_id: delayedJob.order_id,
        stage: delayedJob.current_stage,
      };
    }
    if (urgentJob) {
      return {
        action: 'START_URGENT',
        message: `Start urgent job #${urgentJob.id} — ${urgentJob.current_stage} stage (${urgentJob.priority})`,
        job_id: urgentJob.id,
        order_id: urgentJob.order_id,
        stage: urgentJob.current_stage,
      };
    }
    if (pendingJob) {
      return {
        action: 'START_NEXT',
        message: `Start next job #${pendingJob.id} — ${pendingJob.current_stage} stage`,
        job_id: pendingJob.id,
        order_id: pendingJob.order_id,
        stage: pendingJob.current_stage,
      };
    }
    return {
      action: 'ALL_CLEAR',
      message: 'All caught up! No pending jobs assigned to you.',
    };
  }
}

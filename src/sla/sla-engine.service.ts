import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SlaEvent, SlaModule, SlaPriority } from './entities/sla-event.entity';
import { NotificationService } from '../notifications/notification.service';
import { DbHealthService } from '../shared/db-health.service';
import { RbacService } from '../rbac/rbac.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../notifications/notification.entity';
import { User } from '../users/entities/user.entity';

// Level-2 (admin) re-notification: 4 h between repeats, stops after 5 total fires.
// This prevents permanent spam for SLA events that are genuinely unresolvable
// until someone manually intervenes; the Admin still gets notified, just not hourly forever.
const NOTIFY_COOLDOWN_MS = 4 * 60 * 60_000; // 4 hours between re-notifications for same SLA
const MAX_ADMIN_RENOTIFY = 5; // after 5 admin pings, silence the event until manually resolved

// The permission whose current holders (per the live RBAC matrix) are treated
// as "the manager" for that module's escalation — not a hardcoded role name,
// so it keeps working if roles are renamed or reassigned in Staff Management.
// ACCOUNTS/DISPATCH have no dedicated "manager" permission today, so they
// intentionally fall straight through to the Admin escalation below.
const MODULE_ESCALATION_PERMISSION: Record<string, string> = {
  CRM: 'lead.assign',
  PRODUCTION: 'production.assign',
};

const JOB_PRIORITY_MAP: Record<string, SlaPriority> = {
  URGENT: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NORMAL: 'MEDIUM',
};

const ENTITY_ROUTES: Record<string, (id: number) => string> = {
  job: (id) => `/production/jobs/${id}`,
  order: (id) => `/orders/${id}`,
  dispatch: (_) => `/dispatch`,
  lead: (id) => `/crm/leads/${id}`,
  followup: (id) => `/crm/leads/${id}`,
};

@Injectable()
export class SlaEngineService {
  private readonly logger = new Logger(SlaEngineService.name);
  private _running = false;

  constructor(
    @InjectRepository(SlaEvent)
    private readonly slaRepo: Repository<SlaEvent>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notifService: NotificationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dbHealth: DbHealthService,
    private readonly rbacService: RbacService,
  ) {}

  // ── SLA creation ─────────────────────────────────────────────────────────────

  async createSlaEvent(params: {
    module: SlaModule;
    entity_type: string;
    entity_id: number;
    entity_label: string;
    assigned_user_id?: number | null;
    priority?: SlaPriority;
    sla_deadline: Date;
    warning_hours_before?: number;
    metadata?: Record<string, any>;
  }): Promise<SlaEvent | null> {
    // One active SLA per entity — skip if already tracking
    const existing = await this.slaRepo.findOne({
      where: {
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        status: Not(In(['RESOLVED'])) as any,
      },
    });
    if (existing) return null;

    const warningHours = params.warning_hours_before ?? 4;
    const warningAt = new Date(
      params.sla_deadline.getTime() - warningHours * 3_600_000,
    );
    const now = new Date();

    return this.slaRepo.save(
      this.slaRepo.create({
        module: params.module,
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        entity_label: params.entity_label,
        assigned_user_id: params.assigned_user_id ?? null,
        priority: params.priority ?? 'MEDIUM',
        sla_deadline: params.sla_deadline,
        warning_at: warningAt > now ? warningAt : null,
        status: 'ACTIVE',
        escalation_level: 0,
        metadata: params.metadata ?? null,
      }),
    );
  }

  async resolveSlaEvent(entity_type: string, entity_id: number): Promise<void> {
    const events = await this.slaRepo.find({
      where: { entity_type, entity_id, status: Not('RESOLVED') as any },
    });
    if (events.length === 0) return;
    const ids = events.map((e) => e.id);
    await this.slaRepo.update(ids, {
      status: 'RESOLVED',
      resolved_at: new Date(),
    });
    for (const event of events) {
      this.eventEmitter.emit('sla.resolved', {
        entity_label: event.entity_label,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        module: event.module,
      });
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────────

  @OnEvent('job.assigned')
  async onJobAssigned(job: {
    id: number;
    assigned_to: number | null;
    due_date: Date | null;
    current_stage: string;
    priority: string;
  }): Promise<void> {
    if (!job.due_date || !job.assigned_to) return;
    try {
      await this.createSlaEvent({
        module: 'PRODUCTION',
        entity_type: 'job',
        entity_id: job.id,
        entity_label: `Job #${job.id} — ${job.current_stage}`,
        assigned_user_id: job.assigned_to,
        priority: JOB_PRIORITY_MAP[job.priority?.toUpperCase()] ?? 'MEDIUM',
        sla_deadline: new Date(job.due_date),
        warning_hours_before: 4,
        metadata: { stage: job.current_stage },
      });
    } catch (e: any) {
      this.logger.warn(`SLA create (job.assigned) failed: ${e?.message}`);
    }
  }

  @OnEvent('job.completed')
  async onJobCompleted(job: { id: number }): Promise<void> {
    try {
      await this.resolveSlaEvent('job', job.id);
    } catch {}
  }

  @OnEvent('dispatch.delivered')
  async onDispatchDelivered(payload: { id: number }): Promise<void> {
    try {
      await this.resolveSlaEvent('dispatch', payload.id);
    } catch {}
  }

  @OnEvent('lead.followup.completed')
  async onFollowupCompleted(payload: { followup_id: number }): Promise<void> {
    try {
      await this.resolveSlaEvent('followup', payload.followup_id);
    } catch {}
  }

  // Resolve lead SLA events when leads reach terminal states
  @OnEvent('lead.converted')
  @OnEvent('lead.lost')
  @OnEvent('lead.closed')
  async onLeadTerminated(payload: { leadId?: number; id?: number }): Promise<void> {
    const id = payload.leadId ?? payload.id;
    if (!id) return;
    try {
      await this.resolveSlaEvent('lead', id);
      await this.resolveSlaEvent('followup_lead', id); // belt-and-suspenders
    } catch {}
  }

  @OnEvent('order.completed')
  @OnEvent('order.cancelled')
  async onOrderTerminated(payload: { orderId?: number; id?: number }): Promise<void> {
    const id = payload.orderId ?? payload.id;
    if (!id) return;
    try {
      await this.resolveSlaEvent('order', id);
    } catch {}
  }

  // ── Cron: evaluate all open SLA events every 5 minutes ───────────────────────

  @Cron('0 */5 * * * *')
  async evaluateSlaEvents(): Promise<void> {
    if (this._running) return;
    this._running = true;
    const now = new Date();
    try {
      const events = await this.slaRepo.find({
        where: [
          { status: 'ACTIVE' },
          { status: 'WARNING' },
          { status: 'ESCALATED' },
        ],
      });
      for (const event of events) {
        await this.processEvent(event, now).catch((e: any) =>
          this.logger.warn(`SLA process failed for ${event.id}: ${e?.message}`),
        );
      }
    } catch (e: any) {
      this.dbHealth.handleError(e, 'SlaEngine.evaluateSlaEvents');
    } finally {
      this._running = false;
    }
  }

  private async processEvent(event: SlaEvent, now: Date): Promise<void> {
    const sinceLastNotif = event.last_notification_at
      ? now.getTime() - new Date(event.last_notification_at).getTime()
      : Infinity;

    const isPastDeadline = now >= new Date(event.sla_deadline);
    const isPastWarning = event.warning_at && now >= new Date(event.warning_at);

    // Level 2 (admin): re-notify every 4 h, but stop after MAX_ADMIN_RENOTIFY total fires.
    // Count is stored in metadata.notif_count (no migration required — field is already JSONB).
    if (event.status === 'ESCALATED' && event.escalation_level >= 2) {
      if (isPastDeadline && sinceLastNotif >= NOTIFY_COOLDOWN_MS) {
        const notifCount = Number(event.metadata?.notif_count ?? 0);
        if (notifCount >= MAX_ADMIN_RENOTIFY) {
          // Silent: too many escalations with no action. Stop pinging until manually resolved.
          return;
        }
        await this.notifyAdmin(event, now);
        await this.slaRepo.manager.query(
          `UPDATE sla_events SET last_notification_at = $1, metadata = COALESCE(metadata,'{}')::jsonb || $2::jsonb WHERE id = $3`,
          [now, JSON.stringify({ notif_count: notifCount + 1 }), event.id],
        );
      }
      return;
    }

    if (isPastDeadline) {
      if (event.escalation_level === 0) {
        const escalated = await this.escalateToManager(event, now);
        if (!escalated) await this.escalateToAdmin(event, now);
      } else if (
        event.escalation_level === 1 &&
        sinceLastNotif >= NOTIFY_COOLDOWN_MS
      ) {
        await this.escalateToAdmin(event, now);
      }
      return;
    }

    if (
      isPastWarning &&
      event.status === 'ACTIVE' &&
      sinceLastNotif >= NOTIFY_COOLDOWN_MS
    ) {
      await this.sendWarning(event, now);
    }
  }

  private async sendWarning(event: SlaEvent, now: Date): Promise<void> {
    const msLeft = new Date(event.sla_deadline).getTime() - now.getTime();
    const minutesLeft = Math.round(msLeft / 60_000);
    const timeStr =
      minutesLeft > 60 ? `${Math.round(minutesLeft / 60)}h` : `${minutesLeft}m`;

    if (event.assigned_user_id) {
      await this.notifService.createNotification({
        user_id: event.assigned_user_id,
        type: NotificationType.REMINDER,
        priority: event.priority as NotificationPriority,
        category: event.module as unknown as NotificationCategory,
        title: `SLA Warning: ${event.entity_label}`,
        message: `Deadline in ${timeStr}. Complete this task to avoid escalation.`,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        action_url: this.getActionUrl(event),
        cooldownMinutes: 55,
        is_automated: true,
      });
    }

    await this.slaRepo.update(event.id, {
      status: 'WARNING',
      last_notification_at: now,
    });
    this.eventEmitter.emit('sla.warning', {
      entity_label: event.entity_label,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      module: event.module,
    });
  }

  private async escalateToManager(
    event: SlaEvent,
    now: Date,
  ): Promise<boolean> {
    const permission = MODULE_ESCALATION_PERMISSION[event.module];
    const managerRoles = permission
      ? this.rbacService.getRoleNamesWithPermission(permission)
      : [];
    const managers = managerRoles.length
      ? await this.userRepo.find({
          where: managerRoles.map((role) => ({ role, is_active: true })),
          select: ['id'],
        })
      : [];

    if (managers.length === 0) return false;

    const overdueStr = this.formatOverdue(now, event.sla_deadline);

    for (const manager of managers) {
      await this.notifService.createNotification({
        user_id: manager.id,
        type: NotificationType.ACTION,
        priority: NotificationPriority.HIGH,
        category: event.module as unknown as NotificationCategory,
        title: `Escalation: ${event.entity_label}`,
        message: `SLA breached by ${overdueStr}. Immediate attention required.`,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        action_url: this.getActionUrl(event),
        cooldownMinutes: 55,
        is_automated: true,
      });
    }

    if (event.assigned_user_id) {
      await this.notifService.createNotification({
        user_id: event.assigned_user_id,
        type: NotificationType.ACTION,
        priority: NotificationPriority.CRITICAL,
        category: event.module as unknown as NotificationCategory,
        title: `OVERDUE: ${event.entity_label}`,
        message: `SLA breached — your manager has been notified. Resolve immediately.`,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        action_url: this.getActionUrl(event),
        cooldownMinutes: 55,
        is_automated: true,
      });
    }

    await this.slaRepo.update(event.id, {
      status: 'ESCALATED',
      escalation_level: 1,
      escalated_at: now,
      last_notification_at: now,
    });
    this.eventEmitter.emit('sla.escalated', {
      entity_label: event.entity_label,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      module: event.module,
      escalation_level: 1,
    });

    return true;
  }

  private async escalateToAdmin(event: SlaEvent, now: Date): Promise<void> {
    await this.notifyAdmin(event, now);
    await this.slaRepo.update(event.id, {
      status: 'ESCALATED',
      escalation_level: 2,
      escalated_at: event.escalated_at ?? now,
      last_notification_at: now,
    });
    this.eventEmitter.emit('sla.escalated', {
      entity_label: event.entity_label,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      module: event.module,
      escalation_level: 2,
    });
  }

  private async notifyAdmin(event: SlaEvent, now: Date): Promise<void> {
    const overdueStr = this.formatOverdue(now, event.sla_deadline);
    await this.notifService.createRoleNotification(['Admin'], {
      type: NotificationType.ACTION,
      priority: NotificationPriority.CRITICAL,
      category: event.module as unknown as NotificationCategory,
      title: `Admin Escalation: ${event.entity_label}`,
      message: `SLA breached by ${overdueStr} with no resolution. Admin action required.`,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      action_url: this.getActionUrl(event),
      cooldownMinutes: 55,
      is_automated: true,
    });
  }

  private getActionUrl(event: SlaEvent): string {
    return ENTITY_ROUTES[event.entity_type]?.(event.entity_id) ?? '/sla';
  }

  private formatOverdue(now: Date, deadline: Date | string): string {
    const ms = now.getTime() - new Date(deadline).getTime();
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // ── Cron: auto-resolve stale SLA events daily at 02:00 ───────────────────────
  // Resolves orphaned events for entities that reached a terminal state without
  // emitting the event this service listens for (e.g. manual DB edits, old records,
  // legacy status changes). This is the permanent fix for "SLA Breached" spam.

  @Cron('0 2 * * *')
  async autoResolveStaleEvents(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const now = new Date();

      // 1. Leads that are CONVERTED or LOST
      await this.slaRepo.manager.query(`
        UPDATE sla_events se
        SET    status = 'RESOLVED', resolved_at = $1
        FROM   leads l
        WHERE  se.entity_type = 'lead'
          AND  se.entity_id   = l.id
          AND  se.status     != 'RESOLVED'
          AND  l.workflow_state IN ('CONVERTED', 'LOST')
      `, [now]);

      // 2. Follow-ups that are completed
      await this.slaRepo.manager.query(`
        UPDATE sla_events se
        SET    status = 'RESOLVED', resolved_at = $1
        FROM   lead_followups lf
        WHERE  se.entity_type = 'followup'
          AND  se.entity_id   = lf.id
          AND  se.status     != 'RESOLVED'
          AND  lf.is_completed = true
      `, [now]);

      // 3. Production jobs that are DONE or CANCELLED
      await this.slaRepo.manager.query(`
        UPDATE sla_events se
        SET    status = 'RESOLVED', resolved_at = $1
        FROM   production_jobs pj
        WHERE  se.entity_type = 'job'
          AND  se.entity_id   = pj.id
          AND  se.status     != 'RESOLVED'
          AND  pj.status IN ('DONE', 'CANCELLED')
      `, [now]);

      // 4. Orders that are COMPLETED, DISPATCHED, or CANCELLED
      await this.slaRepo.manager.query(`
        UPDATE sla_events se
        SET    status = 'RESOLVED', resolved_at = $1
        FROM   orders o
        WHERE  se.entity_type = 'order'
          AND  se.entity_id   = o.id
          AND  se.status     != 'RESOLVED'
          AND  o.status IN ('COMPLETED','DISPATCHED','PARTIAL_DISPATCHED','CANCELLED')
      `, [now]);

      // 5. Dispatch records that are DELIVERED or CANCELLED
      await this.slaRepo.manager.query(`
        UPDATE sla_events se
        SET    status = 'RESOLVED', resolved_at = $1
        FROM   dispatch_orders d
        WHERE  se.entity_type = 'dispatch'
          AND  se.entity_id   = d.id
          AND  se.status     != 'RESOLVED'
          AND  d.status IN ('DELIVERED','CANCELLED')
      `, [now]);

      // 6. Any event ESCALATED for more than 7 days — resolve as stale.
      //    Also catches events where escalated_at is NULL but status is ESCALATED
      //    (created before the column was consistently populated).
      await this.slaRepo.manager.query(`
        UPDATE sla_events
        SET    status = 'RESOLVED', resolved_at = $1
        WHERE  status = 'ESCALATED'
          AND (
            escalated_at < NOW() - INTERVAL '7 days'
            OR escalated_at IS NULL
          )
      `, [now]);

      this.logger.log('[SlaEngine] autoResolveStaleEvents complete');
    } catch (e: any) {
      this.dbHealth.handleError(e, 'SlaEngine.autoResolveStaleEvents');
    } finally {
      this._running = false;
    }
  }

  // ── Cron: scan for overdue lead follow-ups every 30 min (business hours) ─────

  @Cron('0 */30 8-20 * * *')
  async scanOverdueFollowups(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const rows: Array<{
        id: number;
        lead_id: number;
        due_date: string;
        assigned_to: number | null;
      }> = await this.slaRepo.manager.query(`
          SELECT lf.id, lf.lead_id, lf.due_date, l.assigned_to
          FROM lead_followups lf
          JOIN leads l ON l.id = lf.lead_id
          WHERE lf.is_completed = false
            AND lf.due_date IS NOT NULL
            AND lf.due_date < NOW() + INTERVAL '2 hours'
            AND lf.due_date > NOW() - INTERVAL '7 days'
          LIMIT 100
        `);

      for (const row of rows) {
        await this.createSlaEvent({
          module: 'CRM',
          entity_type: 'followup',
          entity_id: row.id,
          entity_label: `Follow-up #${row.id} (Lead #${row.lead_id})`,
          assigned_user_id: row.assigned_to ?? null,
          priority: 'MEDIUM',
          sla_deadline: new Date(row.due_date),
          warning_hours_before: 2,
          metadata: { lead_id: row.lead_id },
        });
      }
    } catch (e: any) {
      this.dbHealth.handleError(e, 'SlaEngine.scanOverdueFollowups');
    } finally {
      this._running = false;
    }
  }

  // ── Manual admin trigger ──────────────────────────────────────────────────────

  async forceResolveStale(): Promise<{ resolved: number }> {
    const now = new Date();
    let resolved = 0;

    // Resolve all ESCALATED events regardless of age — admin explicitly asked
    const r6 = await this.slaRepo.manager.query<{ count: string }[]>(`
      WITH updated AS (
        UPDATE sla_events
        SET    status = 'RESOLVED', resolved_at = $1
        WHERE  status = 'ESCALATED'
        RETURNING id
      ) SELECT COUNT(*) as count FROM updated
    `, [now]);
    resolved += Number(r6[0]?.count ?? 0);

    // Also run the full entity-state cleanup
    await this.autoResolveStaleEvents();

    this.logger.log(`[SlaEngine] forceResolveStale: resolved ${resolved} events`);
    return { resolved };
  }

  // ── Query API ─────────────────────────────────────────────────────────────────

  async listAll(filters: {
    status?: string;
    module?: string;
    priority?: string;
    page?: number;
  }): Promise<{ items: SlaEvent[]; total: number }> {
    const { status, module, priority, page = 1 } = filters;
    const PAGE = 25;

    const qb = this.slaRepo
      .createQueryBuilder('s')
      .orderBy(
        `CASE s.status
           WHEN 'ESCALATED' THEN 0
           WHEN 'WARNING'   THEN 1
           WHEN 'ACTIVE'    THEN 2
           ELSE 3
         END`,
        'ASC',
      )
      .addOrderBy('s.sla_deadline', 'ASC');

    if (status) qb.andWhere('s.status = :status', { status });
    if (module) qb.andWhere('s.module = :module', { module });
    if (priority) qb.andWhere('s.priority = :priority', { priority });

    const total = await qb.getCount();
    const items = await qb
      .skip((page - 1) * PAGE)
      .take(PAGE)
      .getMany();
    return { items, total };
  }

  async listForUser(userId: number): Promise<SlaEvent[]> {
    return this.slaRepo
      .createQueryBuilder('s')
      .where('s.assigned_user_id = :userId', { userId })
      .andWhere("s.status != 'RESOLVED'")
      .orderBy('s.sla_deadline', 'ASC')
      .take(20)
      .getMany();
  }

  async getStats(): Promise<{
    byStatus: Record<string, number>;
    byModule: Record<string, number>;
  }> {
    const rows: Array<{ status: string; module: string; cnt: string }> =
      await this.slaRepo.manager.query(`
        SELECT status, module, COUNT(*) as cnt
        FROM sla_events
        WHERE status != 'RESOLVED'
        GROUP BY status, module
      `);

    const byStatus: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.cnt);
      byModule[row.module] = (byModule[row.module] ?? 0) + Number(row.cnt);
    }
    return { byStatus, byModule };
  }
}

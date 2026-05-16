import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActivityLog, ActivitySource, ActivitySeverity } from './entities/activity-log.entity';

const PAGE_SIZE     = 30;
const MAX_JSON_BYTES = 4096; // 4 KB hard cap on jsonb columns

// Fields that must never be stored even inside nested objects
const REDACT_KEYS = new Set([
  'password', 'password_hash', 'token', 'access_token',
  'refresh_token', 'secret', 'api_key', 'credential', 'private_key',
  'authorization', 'bearer', 'jwt', 'otp',
]);

export interface LogActivityPayload {
  module:                string;
  entity_type?:          string | null;
  entity_id?:            number | null;
  action:                string;
  title:                 string;
  description?:          string | null;
  performed_by_user_id?: number | null;
  performed_by_name?:    string | null;
  performed_by_role?:    string | null;
  source?:               ActivitySource;
  old_value?:            Record<string, any> | null;
  new_value?:            Record<string, any> | null;
  metadata?:             Record<string, any> | null;
  ip_address?:           string | null;
  user_agent?:           string | null;
  severity?:             ActivitySeverity;
}

export interface ActivityFilters {
  module?:     string;
  entity_type?: string;
  entity_id?:  number;
  source?:     string;
  severity?:   string;
  user_id?:    number;
  from?:       string;
  to?:         string;
  page?:       number;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: Repository<ActivityLog>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Core log method ──────────────────────────────────────────────────────────

  async logActivity(payload: LogActivityPayload): Promise<ActivityLog | null> {
    try {
      const log = this.repo.create({
        module:                payload.module,
        entity_type:           payload.entity_type   ?? null,
        entity_id:             payload.entity_id     ?? null,
        action:                payload.action,
        title:                 payload.title.slice(0, 200),
        description:           payload.description   ?? null,
        performed_by_user_id:  payload.performed_by_user_id ?? null,
        performed_by_name:     payload.performed_by_name    ?? null,
        performed_by_role:     payload.performed_by_role    ?? null,
        source:                payload.source   ?? 'SYSTEM',
        old_value:             this.sanitize(payload.old_value),
        new_value:             this.sanitize(payload.new_value),
        metadata:              this.sanitize(payload.metadata),
        ip_address:            (payload.ip_address ?? '').slice(0, 50) || null,
        user_agent:            (payload.user_agent ?? '').slice(0, 300) || null,
        severity:              payload.severity ?? 'INFO',
      });

      const saved = await this.repo.save(log);
      this.eventEmitter.emit('activity.created', saved);
      return saved;
    } catch (e: any) {
      this.logger.warn(`logActivity failed: ${e?.message?.slice(0, 120)}`);
      return null;
    }
  }

  // ── Query: entity timeline ────────────────────────────────────────────────────

  async getEntityTimeline(
    entityType: string,
    entityId: number,
    page = 1,
  ): Promise<{ items: ActivityLog[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.entity_type = :entityType', { entityType })
      .andWhere('a.entity_id = :entityId',  { entityId });

    const total = await qb.getCount();
    const items = await qb
      .orderBy('a.created_at', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE)
      .getMany();

    return { items, total };
  }

  // ── Query: user activity ──────────────────────────────────────────────────────

  async getUserActivity(
    userId: number,
    page = 1,
  ): Promise<{ items: ActivityLog[]; total: number }> {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.performed_by_user_id = :userId', { userId });

    const total = await qb.getCount();
    const items = await qb
      .orderBy('a.created_at', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE)
      .getMany();

    return { items, total };
  }

  // ── Query: global feed with filters ──────────────────────────────────────────

  async getGlobalActivity(filters: ActivityFilters): Promise<{ items: ActivityLog[]; total: number }> {
    const { module, entity_type, source, severity, user_id, from, to, page = 1 } = filters;

    const qb = this.repo.createQueryBuilder('a').orderBy('a.created_at', 'DESC');

    if (module)      qb.andWhere('a.module = :module',                           { module });
    if (entity_type) qb.andWhere('a.entity_type = :entity_type',                 { entity_type });
    if (source)      qb.andWhere('a.source = :source',                           { source });
    if (severity)    qb.andWhere('a.severity = :severity',                        { severity });
    if (user_id)     qb.andWhere('a.performed_by_user_id = :user_id',            { user_id });
    if (from)        qb.andWhere('a.created_at >= :from',                         { from: new Date(from) });
    if (to)          qb.andWhere('a.created_at <= :to',                           { to: new Date(to) });

    const total = await qb.getCount();
    const items = await qb.skip((page - 1) * PAGE_SIZE).take(PAGE_SIZE).getMany();
    return { items, total };
  }

  // ── Security: redact + size-cap ──────────────────────────────────────────────

  private sanitize(obj: Record<string, any> | null | undefined): Record<string, any> | null {
    if (!obj || typeof obj !== 'object') return null;
    const cleaned = this.redact(obj);
    const json    = JSON.stringify(cleaned);
    if (json.length <= MAX_JSON_BYTES) return cleaned;
    // Truncate oversized payload and mark it
    return { _truncated: true, _size: json.length };
  }

  private redact(obj: any, depth = 0): any {
    if (depth > 4) return '[deep]';
    if (Array.isArray(obj))       return obj.slice(0, 20).map(v => this.redact(v, depth + 1));
    if (typeof obj !== 'object' || obj === null) return obj;

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = this.redact(v, depth + 1);
      }
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // @OnEvent handlers — listen to platform events, write activity log entries
  // No circular imports: ActivityModule imports nothing from other business modules
  // ══════════════════════════════════════════════════════════════════════════════

  // ── CRM ──────────────────────────────────────────────────────────────────────

  @OnEvent('crm.lead.created')
  onLeadCreated(e: {
    id: number; name: string; phone: string | null;
    source: string; assigned_to: number | null;
  }): void {
    void this.logActivity({
      module:      'CRM',
      entity_type: 'lead',
      entity_id:   e.id,
      action:      'LEAD_CREATED',
      title:       `Lead created: ${e.name}`,
      source:      e.source === 'WHATSAPP' ? 'WHATSAPP' : e.source === 'AUTOMATION' ? 'AUTOMATION' : 'USER',
      metadata:    { phone: e.phone, source: e.source, assigned_to: e.assigned_to },
      severity:    'INFO',
    });
  }

  @OnEvent('crm.lead.status_changed')
  onLeadStatusChanged(e: {
    id: number; name: string; prev_status: string; new_status: string; assigned_to: number | null;
  }): void {
    void this.logActivity({
      module:      'CRM',
      entity_type: 'lead',
      entity_id:   e.id,
      action:      'STATUS_CHANGED',
      title:       `${e.name}: ${e.prev_status} → ${e.new_status}`,
      source:      'USER',
      old_value:   { status: e.prev_status },
      new_value:   { status: e.new_status },
      severity:    e.new_status === 'LOST' ? 'WARNING' : 'INFO',
    });
  }

  @OnEvent('crm.lead.assigned')
  onLeadAssigned(e: {
    id: number; name: string; assigned_to: number | null;
    assigned_to_name: string | null; assigned_by_id: number; assigned_by_name: string;
  }): void {
    void this.logActivity({
      module:                'CRM',
      entity_type:           'lead',
      entity_id:             e.id,
      action:                'LEAD_ASSIGNED',
      title:                 `${e.name} assigned to ${e.assigned_to_name ?? 'Unassigned'}`,
      source:                'USER',
      performed_by_user_id:  e.assigned_by_id,
      performed_by_name:     e.assigned_by_name,
      new_value:             { assigned_to: e.assigned_to, assigned_to_name: e.assigned_to_name },
      severity:              'INFO',
    });
  }

  @OnEvent('crm.lead.followup.created')
  onFollowupCreated(e: { lead_id: number; lead_name: string; due_date: string; note: string | null; user_id: number | null; user_name: string | null }): void {
    const dueStr = new Date(e.due_date).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               'FOLLOWUP_CREATED',
      title:                `Callback scheduled for ${dueStr}`,
      description:          e.note ?? null,
      source:               'USER',
      performed_by_user_id: e.user_id,
      performed_by_name:    e.user_name,
      severity:             'INFO',
    });
  }

  @OnEvent('crm.lead.followup.completed')
  onFollowupCompleted(e: { lead_id: number; followup_id: number; by_user_id: number; by_user_name: string }): void {
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               'FOLLOWUP_COMPLETED',
      title:                `Follow-up #${e.followup_id} completed`,
      source:               'USER',
      performed_by_user_id: e.by_user_id,
      performed_by_name:    e.by_user_name,
      severity:             'INFO',
    });
  }

  @OnEvent('crm.lead.note_added')
  onNoteAdded(e: { lead_id: number; lead_name: string; by_user_id: number; by_user_name: string }): void {
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               'NOTE_ADDED',
      title:                `Note added to ${e.lead_name}`,
      source:               'USER',
      performed_by_user_id: e.by_user_id,
      performed_by_name:    e.by_user_name,
      severity:             'INFO',
    });
  }

  @OnEvent('crm.lead.automation.toggled')
  onAutomationToggled(e: {
    lead_id: number; action: string; reason: string | null;
    snooze_until?: string; user_id: number; user_name: string | null;
  }): void {
    const titleMap: Record<string, string> = {
      PAUSED:  'Automation paused',
      RESUMED: 'Automation resumed',
      SNOOZED: `Automation snoozed until ${e.snooze_until ?? '?'}`,
    };
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               `AUTOMATION_${e.action}`,
      title:                titleMap[e.action] ?? `Automation ${e.action.toLowerCase()}`,
      description:          e.reason ? `Reason: ${e.reason}` : null,
      source:               'USER',
      performed_by_user_id: e.user_id,
      performed_by_name:    e.user_name,
      severity:             'INFO',
    });
  }

  @OnEvent('crm.lead.action_logged')
  onActionLogged(e: { lead_id: number; lead_name: string; user_id: number | null; user_name: string | null }): void {
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               'CALL_LOGGED',
      title:                `Call outcome logged for ${e.lead_name}`,
      source:               'USER',
      performed_by_user_id: e.user_id,
      performed_by_name:    e.user_name,
      severity:             'INFO',
    });
  }

  @OnEvent('crm.lead.system_note')
  onSystemNote(e: { lead_id: number; note: string; user_id: number | null; user_name: string | null }): void {
    void this.logActivity({
      module:               'CRM',
      entity_type:          'lead',
      entity_id:            e.lead_id,
      action:               'SYSTEM_NOTE',
      title:                e.note.slice(0, 150),
      source:               e.user_id ? 'USER' : 'SYSTEM',
      performed_by_user_id: e.user_id,
      performed_by_name:    e.user_name,
      severity:             'INFO',
    });
  }

  // ── Quotations ───────────────────────────────────────────────────────────────

  @OnEvent('quotation.created')
  onQuotationCreated(e: {
    id: number; quotation_no: string; customer_name: string;
    total_amount: number; user_id: number | null; user_name: string | null;
  }): void {
    void this.logActivity({
      module:               'ACCOUNTS',
      entity_type:          'quotation',
      entity_id:            e.id,
      action:               'QUOTATION_CREATED',
      title:                `Quotation ${e.quotation_no} created for ${e.customer_name}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { total_amount: e.total_amount, customer_name: e.customer_name },
      severity:             'INFO',
    });
  }

  @OnEvent('quotation.generated')
  onQuotationGenerated(e: { id: number; quotation_no: string }): void {
    void this.logActivity({
      module:      'ACCOUNTS',
      entity_type: 'quotation',
      entity_id:   e.id,
      action:      'QUOTATION_GENERATED',
      title:       `Quotation ${e.quotation_no} generated`,
      source:      'USER',
      old_value:   { status: 'DRAFT' },
      new_value:   { status: 'GENERATED' },
      severity:    'INFO',
    });
  }

  // ── Orders / Production ───────────────────────────────────────────────────────

  @OnEvent('order.approved')
  onOrderApproved(e: {
    orderId: number; order_no?: string;
    user_id?: number | null; user_name?: string | null; user_role?: string | null;
  }): void {
    void this.logActivity({
      module:               'ORDERS',
      entity_type:          'order',
      entity_id:            e.orderId,
      action:               'ORDER_APPROVED',
      title:                `Order ${e.order_no ?? e.orderId} approved`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      performed_by_role:    e.user_role ?? null,
      severity:             'INFO',
    });
  }

  @OnEvent('quotation.converted')
  onQuotationConverted(e: {
    quotation_id: number; order_id: number; quotation_no?: string;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'QUOTATIONS',
      entity_type:          'quotation',
      entity_id:            e.quotation_id,
      action:               'QUOTATION_CONVERTED',
      title:                `Quotation ${e.quotation_no ?? e.quotation_id} → Order #${e.order_id}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { order_id: e.order_id },
      severity:             'INFO',
    });
  }

  @OnEvent('production.stage.started')
  onProdStageStarted(e: {
    stage_id: number; job_id: number; department_name?: string;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'PRODUCTION',
      entity_type:          'production_stage',
      entity_id:            e.stage_id,
      action:               'STAGE_STARTED',
      title:                `Production started — ${e.department_name ?? 'stage'}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { job_id: e.job_id },
      severity:             'INFO',
    });
  }

  @OnEvent('production.stage.stopped')
  onProdStageStopped(e: {
    stage_id: number; job_id: number; department_name?: string;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'PRODUCTION',
      entity_type:          'production_stage',
      entity_id:            e.stage_id,
      action:               'STAGE_STOPPED',
      title:                `Work stopped — ${e.department_name ?? 'stage'}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { job_id: e.job_id },
      severity:             'INFO',
    });
  }

  @OnEvent('production.stage.moved')
  onProdStageMoved(e: {
    stage_id: number; job_id: number; department_name?: string;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'PRODUCTION',
      entity_type:          'production_stage',
      entity_id:            e.stage_id,
      action:               'STAGE_MOVED',
      title:                `Handover — ${e.department_name ?? 'next dept'}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { job_id: e.job_id },
      severity:             'INFO',
    });
  }

  @OnEvent('dispatch.confirmed')
  onDispatchConfirmed(e: {
    id: number; order_id: number; dispatch_number?: string; user_id?: number | null;
  }): void {
    void this.logActivity({
      module:               'DISPATCH',
      entity_type:          'dispatch_order',
      entity_id:            e.id,
      action:               'DISPATCH_CONFIRMED',
      title:                `Dispatch ${e.dispatch_number ?? e.id} confirmed`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      metadata:             { order_id: e.order_id },
      severity:             'INFO',
    });
  }

  @OnEvent('service.ticket.closed')
  onServiceTicketClosed(e: {
    ticket_id: number; ticket_number?: string;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'SERVICE',
      entity_type:          'service_ticket',
      entity_id:            e.ticket_id,
      action:               'TICKET_CLOSED',
      title:                `Service ticket ${e.ticket_number ?? e.ticket_id} closed`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      severity:             'INFO',
    });
  }

  @OnEvent('payment.recorded')
  onPaymentRecorded(e: {
    order_id: number; order_no?: string; amount: number;
    user_id?: number | null; user_name?: string | null;
  }): void {
    void this.logActivity({
      module:               'ACCOUNTS',
      entity_type:          'order',
      entity_id:            e.order_id,
      action:               'PAYMENT_RECORDED',
      title:                `Payment ₹${e.amount} recorded${e.order_no ? ` — ${e.order_no}` : ''}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { amount: e.amount },
      severity:             'INFO',
    });
  }

  @OnEvent('order.created')
  onOrderCreated(e: { order_id: number; order_no: string }): void {
    void this.logActivity({
      module:      'ORDERS',
      entity_type: 'order',
      entity_id:   e.order_id,
      action:      'ORDER_CREATED',
      title:       `Order ${e.order_no} created`,
      source:      'USER',
      severity:    'INFO',
    });
  }

  @OnEvent('job.assigned')
  onJobAssigned(job: {
    id: number; assigned_to: number | null;
    current_stage: string; order_id: number; priority: string;
  }): void {
    if (!job.assigned_to) return;
    void this.logActivity({
      module:               'PRODUCTION',
      entity_type:          'job',
      entity_id:            job.id,
      action:               'JOB_ASSIGNED',
      title:                `Job #${job.id} assigned — ${job.current_stage}`,
      source:               'USER',
      performed_by_user_id: job.assigned_to,
      metadata:             { stage: job.current_stage, order_id: job.order_id, priority: job.priority },
      severity:             'INFO',
    });
  }

  @OnEvent('job.completed')
  onJobCompleted(job: { id: number; order_id?: number }): void {
    void this.logActivity({
      module:      'PRODUCTION',
      entity_type: 'job',
      entity_id:   job.id,
      action:      'JOB_COMPLETED',
      title:       `Job #${job.id} completed`,
      source:      'USER',
      severity:    'INFO',
    });
  }

  @OnEvent('job.delayed')
  onJobDelayed(job: { id: number; current_stage: string; assigned_to: number | null; due_date: Date | null }): void {
    void this.logActivity({
      module:               'PRODUCTION',
      entity_type:          'job',
      entity_id:            job.id,
      action:               'JOB_DELAYED',
      title:                `Job #${job.id} overdue — ${job.current_stage}`,
      source:               'SYSTEM',
      performed_by_user_id: job.assigned_to,
      metadata:             { stage: job.current_stage, due_date: job.due_date },
      severity:             'WARNING',
    });
  }

  @OnEvent('payment.received')
  onPaymentReceived(e: { order_id: number; order_no: string; amount: number; user_id: number | null; user_name: string | null }): void {
    void this.logActivity({
      module:               'ACCOUNTS',
      entity_type:          'order',
      entity_id:            e.order_id,
      action:               'PAYMENT_RECEIVED',
      title:                `Payment ₹${e.amount} received for ${e.order_no}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      performed_by_name:    e.user_name ?? null,
      metadata:             { amount: e.amount, order_no: e.order_no },
      severity:             'INFO',
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────────

  @OnEvent('dispatch.created')
  onDispatchCreated(e: { id: number; order_id: number; user_id: number | null }): void {
    void this.logActivity({
      module:               'DISPATCH',
      entity_type:          'dispatch',
      entity_id:            e.id,
      action:               'DISPATCH_CREATED',
      title:                `Dispatch created for Order #${e.order_id}`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      metadata:             { order_id: e.order_id },
      severity:             'INFO',
    });
  }

  @OnEvent('dispatch.delivered')
  onDispatchDelivered(e: { id: number; order_id: number; user_id: number | null }): void {
    void this.logActivity({
      module:               'DISPATCH',
      entity_type:          'dispatch',
      entity_id:            e.id,
      action:               'DISPATCH_DELIVERED',
      title:                `Order #${e.order_id} delivered`,
      source:               'USER',
      performed_by_user_id: e.user_id ?? null,
      metadata:             { order_id: e.order_id },
      new_value:            { status: 'DELIVERED' },
      severity:             'INFO',
    });
  }

  // ── WhatsApp ──────────────────────────────────────────────────────────────────

  @OnEvent('whatsapp.down')
  onWhatsAppDown(e: { reason: string }): void {
    const isCritical = ['AUTH_FAILURE', 'CONFLICT'].includes(e.reason);
    void this.logActivity({
      module:   'SYSTEM',
      action:   'WHATSAPP_DOWN',
      title:    `WhatsApp disconnected: ${e.reason}`,
      source:   'SYSTEM',
      metadata: { reason: e.reason },
      severity: isCritical ? 'CRITICAL' : 'ERROR',
    });
  }

  @OnEvent('whatsapp.up')
  onWhatsAppUp(_e: any): void {
    void this.logActivity({
      module:   'SYSTEM',
      action:   'WHATSAPP_UP',
      title:    'WhatsApp reconnected',
      source:   'SYSTEM',
      severity: 'INFO',
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────

  @OnEvent('auth.login')
  onAuthLogin(e: { user_id: number; name: string; role: string; ip: string | null }): void {
    void this.logActivity({
      module:               'AUTH',
      action:               'USER_LOGIN',
      title:                `${e.name} logged in`,
      source:               'USER',
      performed_by_user_id: e.user_id,
      performed_by_name:    e.name,
      performed_by_role:    e.role,
      ip_address:           e.ip,
      severity:             'INFO',
    });
  }

  // ── SLA ───────────────────────────────────────────────────────────────────────

  @OnEvent('sla.warning')
  onSlaWarning(e: { entity_label: string; entity_type: string; entity_id: number; module: string }): void {
    void this.logActivity({
      module:      e.module,
      entity_type: e.entity_type,
      entity_id:   e.entity_id,
      action:      'SLA_WARNING',
      title:       `SLA warning: ${e.entity_label}`,
      source:      'SYSTEM',
      severity:    'WARNING',
    });
  }

  @OnEvent('sla.escalated')
  onSlaEscalated(e: {
    entity_label: string; entity_type: string; entity_id: number;
    module: string; escalation_level: number;
  }): void {
    void this.logActivity({
      module:      e.module,
      entity_type: e.entity_type,
      entity_id:   e.entity_id,
      action:      'SLA_ESCALATED',
      title:       `SLA escalated (L${e.escalation_level}): ${e.entity_label}`,
      source:      'SYSTEM',
      severity:    'CRITICAL',
    });
  }

  @OnEvent('sla.resolved')
  onSlaResolved(e: { entity_label: string; entity_type: string; entity_id: number; module: string }): void {
    void this.logActivity({
      module:      e.module,
      entity_type: e.entity_type,
      entity_id:   e.entity_id,
      action:      'SLA_RESOLVED',
      title:       `SLA resolved: ${e.entity_label}`,
      source:      'SYSTEM',
      severity:    'INFO',
    });
  }
}

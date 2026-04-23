import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  normalizePhone,
  isValidPhone,
  toSentenceCase,
  sentenceCaseWords,
} from './normalizers/lead-normalizer';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Lead, LeadSource, LeadStatus, LeadPriority } from './entities/lead.entity';
import { LeadNote, NoteType } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { User } from '../users/entities/user.entity';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService, DecisionContext } from './decision-engine.service';
import { LeadAuditService } from './lead-audit.service';

// Allowed forward-only status transitions.
// Admin/COO bypass this check entirely.
const VALID_TRANSITIONS: Record<string, string[]> = {
  NEW:        ['CONTACTED', 'LOST'],
  CONTACTED:  ['INTERESTED', 'LOST'],
  INTERESTED: ['QUOTATION', 'CONTACTED', 'LOST'],
  QUOTATION:  ['CONVERTED', 'INTERESTED', 'LOST'],
  CONVERTED:  [],
  LOST:       ['CONTACTED'],
};

const WORKFLOW_BYPASS_ROLES = ['Admin', 'COO'];

/** Deterministic idempotency key for Shopify leads.
 *  Uses bare 10-digit phone for the hash so format changes don't invalidate existing keys. */
function generateShopifyExternalId(payload: {
  phone?: string; action?: string; lead_type?: string; product?: string;
}): string {
  const phone = normalizePhone(payload.phone || '').replace(/\D/g, '').slice(-10);
  const type    = (payload.action || payload.lead_type || 'enquiry').toLowerCase().replace(/\s+/g, '_');
  const product = (payload.product || '').toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  const raw     = `shopify_${type}_${phone}_${product}`;
  return 'sh_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

@Injectable()
export class LeadService implements OnModuleInit {
  private readonly logger = new Logger(LeadService.name);

  // Tracks WhatsApp connectivity via event bus — set/cleared by whatsapp.down / whatsapp.up.
  // No direct import of WhatsAppService needed (avoids CrmModule ↔ WhatsappModule coupling).
  private _whatsappDown = false;

  constructor(
    @InjectRepository(Lead)
    private leadRepo: Repository<Lead>,
    @InjectRepository(LeadNote)
    private noteRepo: Repository<LeadNote>,
    @InjectRepository(LeadFollowUp)
    private followUpRepo: Repository<LeadFollowUp>,
    @InjectDataSource()
    private ds: DataSource,
    private assignmentService: LeadAssignmentService,
    private decisionEngine: DecisionEngineService,
    private auditService: LeadAuditService,
  ) {}

  async onModuleInit() {
    // Verify that pending migrations have been applied. Missing columns cause silent
    // failures in createFromShopifyClick (errors are swallowed so the Shopify theme
    // JS gets a clean response). Catching it here makes the problem immediately visible.
    try {
      await this.ds.query(`SELECT tags FROM leads LIMIT 0`);
    } catch {
      this.logger.error(
        '┌─────────────────────────────────────────────────────────────┐\n' +
        '│  MIGRATION REQUIRED — leads.tags column is missing          │\n' +
        '│  Shopify leads will silently fail until you run:            │\n' +
        '│    npm run migrate:crm-hardening                            │\n' +
        '└─────────────────────────────────────────────────────────────┘',
      );
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, user: any): Promise<{ lead: Lead; warning?: string }> {
    console.log(`[DEBUG] Creating lead in DB — source=${dto.source} phone=${dto.phone} user_id=${user?.id ?? 'null'}`);

    // Coerce legacy 'MANUAL' source values from older clients / DB rows
    if ((dto.source as string) === 'MANUAL') (dto as any).source = LeadSource.DIRECT;

    const phone = normalizePhone(dto.phone);
    if (!isValidPhone(phone)) {
      throw new BadRequestException('A valid phone number is required (e.g. 9876543210 or +919876543210).');
    }

    if (dto.external_id) {
      const existing = await this.findByExternalId(dto.external_id);
      if (existing) return { lead: existing };
    }

    let assignedTo = dto.assigned_to;
    if (!assignedTo) {
      assignedTo = await this.assignmentService.getNextAssignee(dto.source) ?? undefined;
      if (!assignedTo) {
        this.logger.warn(`No eligible telecaller found for source=${dto.source} — lead will be unassigned`);
      }
    }

    const dupCount = await this.leadRepo.count({ where: { phone, is_active: true } });

    const lead = this.leadRepo.create({
      ...dto,
      name: sentenceCaseWords(dto.name),
      phone,
      notes: dto.notes ? toSentenceCase(dto.notes) : undefined,
      product_interest: dto.product_interest ? sentenceCaseWords(dto.product_interest) : undefined,
      assigned_to: assignedTo,
      created_by: user?.id,
      duplicate_flag: dupCount > 0,
    });

    // WhatsApp fallback: when the channel is down, telecaller must call the customer
    // manually. Escalate priority and surface a clear instruction note so the lead
    // rises to the top of the queue and the assigned telecaller knows what to do.
    if (this._whatsappDown && assignedTo) {
      if (lead.lead_priority !== LeadPriority.HIGH) {
        lead.lead_priority = LeadPriority.HIGH;
      }
      const currentTags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
      if (!currentTags.includes('whatsapp_unavailable')) {
        lead.tags = [...currentTags, 'whatsapp_unavailable'];
      }
      const fallbackNote = 'WhatsApp down — call customer directly';
      lead.notes = lead.notes ? `${fallbackNote}\n${lead.notes}` : fallbackNote;
      this.logger.warn(
        `[LeadService] WhatsApp fallback applied — lead escalated to HIGH, assigned_to=${assignedTo}`,
      );
    }

    const saved = await this.leadRepo.save(lead);
    this.logger.log(
      `Lead created id=${saved.id} phone=${phone} source=${dto.source} assigned_to=${assignedTo ?? 'none'}${dupCount > 0 ? ' [DUPLICATE]' : ''}${this._whatsappDown ? ' [WA_FALLBACK]' : ''}`,
    );

    if (dto.source !== LeadSource.DIRECT) {
      await this.scheduleFirstFollowUp(saved);
    }

    return { lead: saved, warning: dupCount > 0 ? 'duplicate_phone' : undefined };
  }

  // ── List / Detail ────────────────────────────────────────────────────────────

  async findAll(filters: any, user: any): Promise<Lead[]> {
    const q = this.leadRepo.createQueryBuilder('l');
    q.where('l.is_active = true');

    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (!fullAccessRoles.includes(user?.role)) {
      // Show leads explicitly assigned/created by this user, plus unowned leads
      // (assigned_to IS NULL AND created_by IS NULL) — these are system-generated
      // webhook/Shopify leads that haven't been assigned yet. They form an open pool
      // any telecaller can pick up; once assigned they disappear from others' views.
      q.andWhere(
        '(l.assigned_to = :uid OR l.created_by = :uid OR (l.assigned_to IS NULL AND l.created_by IS NULL))',
        { uid: user.id },
      );
    }

    if (filters.status) q.andWhere('l.status = :status', { status: filters.status });
    if (filters.source) q.andWhere('l.source = :source', { source: filters.source });
    if (filters.assigned_to) q.andWhere('l.assigned_to = :at', { at: filters.assigned_to });
    if (filters.search) {
      q.andWhere('(l.name ILIKE :s OR l.phone ILIKE :s OR l.email ILIKE :s)', {
        s: `%${filters.search}%`,
      });
    }
    if (filters.from) q.andWhere('l.created_at >= :from', { from: filters.from });
    if (filters.to) q.andWhere('l.created_at <= :to', { to: filters.to });

    q.orderBy('l.created_at', 'DESC');
    return q.getMany();
  }

  async findOne(
    id: number,
    user: any,
    ip?: string,
  ): Promise<Lead & { activityNotes: LeadNote[]; followups: LeadFollowUp[] }> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    void this.auditService.log(id, user.id, 'VIEWED', undefined, ip);

    const notes = await this.noteRepo.find({
      where: { lead_id: id },
      order: { created_at: 'DESC' },
    });
    const followups = await this.followUpRepo.find({
      where: { lead_id: id },
      order: { due_date: 'ASC' },
    });

    return { ...lead, activityNotes: notes, followups };
  }

  // ── Decision Engine endpoints ────────────────────────────────────────────────

  /** Prioritised queue for the telecaller — active leads sorted by score + overdue flag */
  async getQueue(user: any): Promise<any[]> {
    const q = this.leadRepo.createQueryBuilder('l');
    q.where('l.is_active = true');
    q.andWhere('l.status NOT IN (:...done)', { done: ['CONVERTED'] });

    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (!fullAccessRoles.includes(user?.role)) {
      q.andWhere('(l.assigned_to = :uid OR l.created_by = :uid)', { uid: user.id });
    }

    q.orderBy('l.created_at', 'DESC');
    const leads = await q.getMany();

    const now = Date.now();
    const scored = leads.map((lead) => {
      const score = this.decisionEngine.scoreLead(lead);
      const nextAction = this.decisionEngine.getNextAction(lead);
      const isOverdue = !!(lead.follow_up_date && new Date(lead.follow_up_date).getTime() < now);
      const ageHours = Math.round((now - new Date(lead.created_at).getTime()) / 3_600_000);
      return { lead, score, nextAction, isOverdue, ageHours };
    });

    // Overdue leads first, then by score desc
    scored.sort((a, b) => {
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      return b.score - a.score;
    });

    return scored;
  }

  /** Full decision context for a single lead */
  async getDecision(id: number, user: any): Promise<DecisionContext> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    return this.decisionEngine.getDecisionContext(lead);
  }

  /** Log a call outcome note and optionally advance stage */
  async logAction(
    id: number,
    body: { note: string; noteType?: NoteType; newStatus?: string },
    user: any,
    ip?: string,
  ): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const noteType = body.noteType ?? NoteType.CALL;
    await this.noteRepo.save(
      this.noteRepo.create({
        lead_id: id,
        note: toSentenceCase(body.note),
        type: noteType,
        created_by: user?.id,
      }),
    );

    if (noteType === NoteType.CALL) {
      void this.auditService.log(id, user.id, 'CALLED', body.note.slice(0, 120), ip);
    }

    if (body.newStatus && body.newStatus !== lead.status) {
      return this.update(id, { status: body.newStatus as LeadStatus } as UpdateLeadDto, user, ip);
    }

    return lead;
  }

  // ── Update (with workflow enforcement) ──────────────────────────────────────

  async update(id: number, dto: UpdateLeadDto, user: any, ip?: string): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    if (dto.phone) dto.phone = normalizePhone(dto.phone);
    if (dto.name) dto.name = sentenceCaseWords(dto.name);
    if ((dto as any).notes) (dto as any).notes = toSentenceCase((dto as any).notes);
    if (dto.product_interest) dto.product_interest = sentenceCaseWords(dto.product_interest);

    // Workflow enforcement — block invalid stage jumps for non-bypass roles
    if (dto.status && dto.status !== lead.status) {
      if (!WORKFLOW_BYPASS_ROLES.includes(user?.role)) {
        const allowed = VALID_TRANSITIONS[lead.status] ?? [];
        if (!allowed.includes(dto.status)) {
          throw new BadRequestException(
            `Cannot move lead from ${lead.status} to ${dto.status}. ` +
              `Next allowed stages: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`,
          );
        }
      }

      const prevStatus = lead.status;
      Object.assign(lead, dto);
      const saved = await this.leadRepo.save(lead);

      void this.auditService.log(id, user.id, 'STATUS_CHANGED', `${prevStatus} → ${saved.status}`, ip);

      // Auto-schedule follow-up when stage advances
      if (prevStatus !== saved.status) {
        await this.autoScheduleFollowUp(saved, saved.status as LeadStatus, user);
      }

      return saved;
    }

    Object.assign(lead, dto);
    const saved = await this.leadRepo.save(lead);
    void this.auditService.log(id, user.id, 'UPDATED', undefined, ip);
    return saved;
  }

  // ── Other CRUD ───────────────────────────────────────────────────────────────

  async softDelete(id: number, user: any): Promise<void> {
    const lead = await this.leadRepo.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    lead.is_active = false;
    await this.leadRepo.save(lead);
  }

  async assignLead(id: number, userId: number, user: any, ip?: string): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const managerRoles = ['Admin', 'COO', 'Sales Manager'];
    if (!managerRoles.includes(user?.role)) {
      this.assertAccess(lead, user);
    }

    const target = await this.leadRepo.manager.findOne(User, {
      where: { id: userId, is_active: true },
    });
    if (!target) throw new BadRequestException('Target user not found or inactive');

    lead.assigned_to = userId;
    const saved = await this.leadRepo.save(lead);
    void this.auditService.log(id, user.id, 'ASSIGNED', `→ ${target.name} (id=${userId})`, ip);
    return saved;
  }

  async addNote(leadId: number, body: { note: string; type?: NoteType }, user: any): Promise<LeadNote> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const note = this.noteRepo.create({
      lead_id: leadId,
      note: toSentenceCase(body.note),
      type: body.type ?? NoteType.GENERAL,
      created_by: user.id,
    });
    return this.noteRepo.save(note);
  }

  async getNotes(leadId: number, user: any): Promise<LeadNote[]> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    return this.noteRepo.find({ where: { lead_id: leadId }, order: { created_at: 'DESC' } });
  }

  async addFollowUp(leadId: number, body: { due_date: string; note?: string }, user: any, ip?: string): Promise<LeadFollowUp> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const fu = this.followUpRepo.create({
      lead_id: leadId,
      due_date: new Date(body.due_date),
      note: body.note ? toSentenceCase(body.note) : undefined,
      created_by: user.id,
    });
    lead.follow_up_date = fu.due_date;
    await this.leadRepo.save(lead);
    const saved = await this.followUpRepo.save(fu);
    void this.auditService.log(leadId, user.id, 'FOLLOWUP_CREATED', `due: ${body.due_date}`, ip);
    return saved;
  }

  async completeFollowUp(followUpId: number, user: any, ip?: string): Promise<LeadFollowUp> {
    const fu = await this.followUpRepo.findOne({ where: { id: followUpId } });
    if (!fu) throw new NotFoundException('Follow-up not found');

    const lead = await this.leadRepo.findOne({ where: { id: fu.lead_id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    fu.is_completed = true;
    fu.completed_at = new Date();
    fu.completed_by = user.id;
    const saved = await this.followUpRepo.save(fu);
    void this.auditService.log(fu.lead_id, user.id, 'FOLLOWUP_COMPLETED', `followup_id=${followUpId}`, ip);
    return saved;
  }

  async getDueFollowUps(): Promise<LeadFollowUp[]> {
    const window = new Date(Date.now() + 30 * 60 * 1000);
    return this.followUpRepo
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.lead', 'l')
      .where('f.is_completed = false')
      .andWhere('f.due_date <= :window', { window })
      .andWhere('l.is_active = true')
      .getMany();
  }

  async checkConvert(id: number, user: any): Promise<any> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Customer table stores bare 10-digit phones; lead.phone is +E.164 — strip for comparison
    const bare10 = lead.phone.replace(/\D/g, '').slice(-10);
    const existing = await this.leadRepo.manager.query(
      `SELECT id, "companyName", "contactName", mobile1, email, city
       FROM customer WHERE mobile1 = $1 OR mobile1 = $2 LIMIT 1`,
      [bare10, lead.phone],
    );

    const customerExists = existing.length > 0;
    return {
      customerExists,
      customerId: customerExists ? existing[0].id : null,
      prefillData: {
        contactName: lead.name,
        mobile1: lead.phone,
        email: lead.email ?? '',
        companyName: lead.name,
        product_interest: lead.product_interest ?? '',
      },
    };
  }

  async markConverted(id: number, customerId: number, quotationId: number, user: any, ip?: string): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    lead.status = LeadStatus.CONVERTED;
    lead.customer_id = customerId;
    lead.quotation_id = quotationId;
    const saved = await this.leadRepo.save(lead);
    void this.auditService.log(id, user.id, 'CONVERTED', `customer_id=${customerId} quotation_id=${quotationId}`, ip);
    return saved;
  }

  /** Entry-point for Shopify theme JS events (POST /api/leads/shopify).
   *  Routes through the standard create() so dedup, assignment, and follow-up all apply. */
  async createFromShopifyClick(payload: {
    source?: string; action?: string; name?: string; phone?: string;
    message?: string; product?: string; product_url?: string;
    page_url?: string; lead_type?: string; priority?: string; timestamp?: string;
  }): Promise<{ ok: boolean; leadId?: number; error?: string }> {
    console.log('SHOPIFY PAYLOAD:', JSON.stringify(payload));

    const externalId = generateShopifyExternalId(payload);

    const name = payload.name
      ? payload.name
      : `Shopify Lead - ${payload.product || 'Enquiry'}`;

    const notes = [
      payload.message     ? `Message: ${payload.message}`         : null,
      payload.action      ? `Action: ${payload.action}`           : null,
      payload.lead_type   ? `Type: ${payload.lead_type}`          : null,
      payload.product_url ? `Product URL: ${payload.product_url}` : null,
      payload.page_url    ? `Page: ${payload.page_url}`           : null,
      payload.timestamp   ? `Clicked at: ${payload.timestamp}`    : null,
    ].filter(Boolean).join('\n');

    const priority = (['LOW', 'MEDIUM', 'HIGH'].includes((payload.priority ?? '').toUpperCase())
      ? payload.priority!.toUpperCase()
      : 'MEDIUM') as LeadPriority;

    const action = payload.action || payload.lead_type || '';
    const dto = {
      name,
      phone: payload.phone || 'unknown',
      source: LeadSource.SHOPIFY,
      product_interest: payload.product ?? undefined,
      requirement_note: payload.message ? toSentenceCase(payload.message) : undefined,
      lead_priority: priority,
      utm_source: action || 'shopify',
      utm_campaign: payload.product ?? undefined,
      lead_source_label: (action || 'shopify').slice(0, 50),
      channel: action.toLowerCase().includes('whatsapp') ? 'WHATSAPP' : 'FORM',
      landing_page: payload.page_url ?? undefined,
      notes: notes || undefined,
      external_id: externalId,
      raw_payload: payload,
    } as CreateLeadDto;

    try {
      const { lead } = await this.create(dto, { id: null, role: 'Admin' });
      console.log('LEAD CREATED:', { id: lead.id, phone: lead.phone, source: lead.source });
      this.logger.log(`Shopify lead id=${lead.id} external_id=${externalId}`);
      return { ok: true, leadId: lead.id };
    } catch (e: any) {
      console.error('SHOPIFY ERROR:', e?.message, e?.stack);
      if (e instanceof BadRequestException) throw e;
      // Unique index violation — concurrent duplicate submission
      if (e?.code === '23505' || e?.message?.includes('unique') || e?.message?.includes('duplicate')) {
        const existing = await this.findByExternalId(externalId);
        if (existing) return { ok: true, leadId: existing.id };
      }
      this.logger.error(`createFromShopifyClick failed: ${e?.message}`, e?.stack);
      return { ok: false, error: e?.message };
    }
  }

  async findByExternalId(externalId: string): Promise<Lead | null> {
    return this.leadRepo.findOne({ where: { external_id: externalId } });
  }

  @OnEvent('whatsapp.down')
  onWhatsAppDown(): void {
    this._whatsappDown = true;
    this.logger.warn('[LeadService] WhatsApp is down — incoming leads will be escalated to HIGH priority');
  }

  @OnEvent('whatsapp.up')
  onWhatsAppUp(): void {
    this._whatsappDown = false;
    this.logger.log('[LeadService] WhatsApp restored — normal lead priority resumed');
  }

  @OnEvent('lead.incoming')
  async handleIncomingLead(payload: {
    phone: string;
    name: string;
    source: LeadSource;
    whatsapp_chat_id?: string;
    raw_payload?: any;
    external_id?: string;
  }): Promise<void> {
    try {
      await this.create(
        {
          phone: payload.phone,
          name: payload.name,
          source: payload.source,
          whatsapp_chat_id: payload.whatsapp_chat_id,
          raw_payload: payload.raw_payload,
          external_id: payload.external_id,
          channel: 'WHATSAPP',
          lead_source_label: 'inbound_message',
        } as CreateLeadDto,
        { id: null, role: 'Admin' },
      );
    } catch (e) {
      this.logger.error(`handleIncomingLead failed for phone=${payload.phone}: ${e?.message}`, e?.stack);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private assertAccess(lead: Lead, user: any) {
    const fullAccess = ['Admin', 'COO', 'Sales Manager'];
    if (fullAccess.includes(user?.role)) return;
    if (lead.assigned_to !== user?.id && lead.created_by !== user?.id) {
      // NotFoundException instead of ForbiddenException intentionally: returning 403 on a valid
      // lead ID confirms the resource exists and its ownership — an enumeration oracle. 404 is
      // indistinguishable from "no such lead", so an attacker learns nothing by probing IDs.
      throw new NotFoundException('Lead not found');
    }
  }

  private async scheduleFirstFollowUp(lead: Lead): Promise<void> {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    const fu = this.followUpRepo.create({
      lead_id: lead.id,
      due_date: due,
      note: 'Initial follow-up',
      created_by: lead.created_by ?? lead.assigned_to ?? null,
    });
    await this.followUpRepo.save(fu);
    lead.follow_up_date = due;
    await this.leadRepo.save(lead);
  }

  /** Auto-schedule the next follow-up when a lead advances to a new stage. */
  private async autoScheduleFollowUp(lead: Lead, newStatus: LeadStatus, user: any): Promise<void> {
    let daysAhead: number | null = null;
    let noteText: string | null = null;

    if (newStatus === LeadStatus.CONTACTED) {
      daysAhead = 2;
      noteText = 'Auto-scheduled: follow up after first contact';
    } else if (newStatus === LeadStatus.INTERESTED) {
      daysAhead = 1;
      noteText = 'Auto-scheduled: send quotation';
    } else if (newStatus === LeadStatus.QUOTATION) {
      daysAhead = 3;
      noteText = 'Auto-scheduled: follow up on quotation';
    }

    if (!daysAhead) return;

    const due = new Date();
    due.setDate(due.getDate() + daysAhead);
    const fu = this.followUpRepo.create({
      lead_id: lead.id,
      due_date: due,
      note: noteText!,
      created_by: user?.id ?? lead.assigned_to ?? null,
    });
    await this.followUpRepo.save(fu);
    lead.follow_up_date = due;
    await this.leadRepo.save(lead);
  }
}

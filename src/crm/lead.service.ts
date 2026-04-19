import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Lead, LeadSource, LeadStatus, LeadPriority } from './entities/lead.entity';
import { LeadNote, NoteType } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService, DecisionContext } from './decision-engine.service';

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

function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.slice(-10);
}

function toSentenceCase(s: string): string {
  if (!s) return s;
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function sentenceCaseWords(s: string): string {
  if (!s) return s;
  return s.trim().toLowerCase().replace(/(^\w|\.\s+\w)/g, (c) => c.toUpperCase());
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(
    @InjectRepository(Lead)
    private leadRepo: Repository<Lead>,
    @InjectRepository(LeadNote)
    private noteRepo: Repository<LeadNote>,
    @InjectRepository(LeadFollowUp)
    private followUpRepo: Repository<LeadFollowUp>,
    private assignmentService: LeadAssignmentService,
    private decisionEngine: DecisionEngineService,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, user: any): Promise<{ lead: Lead; warning?: string }> {
    const phone = normalizePhone(dto.phone);
    if (phone.length !== 10) {
      throw new BadRequestException('Phone number must be 10 digits. Please check and try again.');
    }

    if (dto.external_id) {
      const existing = await this.findByExternalId(dto.external_id);
      if (existing) return { lead: existing };
    }

    let assignedTo = dto.assigned_to;
    if (!assignedTo) {
      assignedTo = await this.assignmentService.getNextAssignee(dto.source) ?? undefined;
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

    const saved = await this.leadRepo.save(lead);
    this.logger.log(
      `Lead created id=${saved.id} phone=${phone} source=${dto.source} assigned_to=${assignedTo ?? 'none'}${dupCount > 0 ? ' [DUPLICATE]' : ''}`,
    );

    if (dto.source !== LeadSource.MANUAL) {
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
      q.andWhere('l.assigned_to = :uid OR l.created_by = :uid', { uid: user.id });
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
  ): Promise<Lead & { activityNotes: LeadNote[]; followups: LeadFollowUp[] }> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

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
  ): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    await this.noteRepo.save(
      this.noteRepo.create({
        lead_id: id,
        note: toSentenceCase(body.note),
        type: body.noteType ?? NoteType.CALL,
        created_by: user?.id,
      }),
    );

    if (body.newStatus && body.newStatus !== lead.status) {
      return this.update(id, { status: body.newStatus as LeadStatus } as UpdateLeadDto, user);
    }

    return lead;
  }

  // ── Update (with workflow enforcement) ──────────────────────────────────────

  async update(id: number, dto: UpdateLeadDto, user: any): Promise<Lead> {
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

      // Auto-schedule follow-up when stage advances
      if (prevStatus !== saved.status) {
        await this.autoScheduleFollowUp(saved, saved.status as LeadStatus, user);
      }

      return saved;
    }

    Object.assign(lead, dto);
    return this.leadRepo.save(lead);
  }

  // ── Other CRUD ───────────────────────────────────────────────────────────────

  async softDelete(id: number, user: any): Promise<void> {
    const lead = await this.leadRepo.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    lead.is_active = false;
    await this.leadRepo.save(lead);
  }

  async assignLead(id: number, userId: number, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    lead.assigned_to = userId;
    return this.leadRepo.save(lead);
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

  async getNotes(leadId: number): Promise<LeadNote[]> {
    return this.noteRepo.find({ where: { lead_id: leadId }, order: { created_at: 'DESC' } });
  }

  async addFollowUp(leadId: number, body: { due_date: string; note?: string }, user: any): Promise<LeadFollowUp> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const fu = this.followUpRepo.create({
      lead_id: leadId,
      due_date: new Date(body.due_date),
      note: body.note ? toSentenceCase(body.note) : undefined,
      created_by: user.id,
    });
    lead.follow_up_date = fu.due_date;
    await this.leadRepo.save(lead);
    return this.followUpRepo.save(fu);
  }

  async completeFollowUp(followUpId: number, user: any): Promise<LeadFollowUp> {
    const fu = await this.followUpRepo.findOne({ where: { id: followUpId } });
    if (!fu) throw new NotFoundException('Follow-up not found');
    fu.is_completed = true;
    fu.completed_at = new Date();
    fu.completed_by = user.id;
    return this.followUpRepo.save(fu);
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

  async checkConvert(id: number): Promise<any> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const existing = await this.leadRepo.manager.query(
      `SELECT id, "companyName", "contactName", mobile1, email, city
       FROM customer WHERE mobile1 = $1 LIMIT 1`,
      [lead.phone],
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

  async markConverted(id: number, customerId: number, quotationId: number, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    lead.status = LeadStatus.CONVERTED;
    lead.customer_id = customerId;
    lead.quotation_id = quotationId;
    return this.leadRepo.save(lead);
  }

  /** Structured entry-point for Shopify WhatsApp-click events (POST /api/leads/shopify) */
  async createFromShopifyClick(payload: {
    source?: string; action?: string; name?: string; phone?: string;
    message?: string; product?: string; product_url?: string;
    page_url?: string; lead_type?: string; priority?: string; timestamp?: string;
  }): Promise<{ ok: boolean; leadId?: number }> {
    try {
      const assignedTo =
        (await this.assignmentService.getNextAssignee(LeadSource.SHOPIFY)) ?? undefined;

      const notes = [
        payload.message     ? `Message: ${payload.message}`         : null,
        payload.action      ? `Action: ${payload.action}`           : null,
        payload.lead_type   ? `Type: ${payload.lead_type}`          : null,
        payload.product_url ? `Product URL: ${payload.product_url}` : null,
        payload.page_url    ? `Page: ${payload.page_url}`           : null,
        payload.timestamp   ? `Clicked at: ${payload.timestamp}`    : null,
      ]
        .filter(Boolean)
        .join('\n');

      const priority = (['LOW', 'MEDIUM', 'HIGH'].includes((payload.priority ?? '').toUpperCase())
        ? payload.priority!.toUpperCase()
        : 'MEDIUM') as LeadPriority;

      const lead = this.leadRepo.create({
        name: payload.name
          ? payload.name
          : payload.product
            ? `Shopify Enquiry — ${payload.product}`
            : 'Shopify Enquiry',
        phone: payload.phone ? normalizePhone(payload.phone) || '0000000000' : '0000000000',
        source: LeadSource.SHOPIFY,
        status: LeadStatus.NEW,
        product_interest: payload.product ?? undefined,
        lead_priority: priority,
        assigned_to: assignedTo,
        notes: notes || undefined,
        utm_source: payload.source ?? 'shopify',
        is_active: true,
        duplicate_flag: false,
      });

      const saved = await this.leadRepo.save(lead);
      this.logger.log(`Shopify click lead created id=${saved.id} product="${payload.product}" assigned_to=${assignedTo ?? 'none'}`);
      return { ok: true, leadId: saved.id };
    } catch (e) {
      this.logger.error(`createFromShopifyClick failed: ${e?.message}`, e?.stack);
      return { ok: false };
    }
  }

  async findByExternalId(externalId: string): Promise<Lead | null> {
    return this.leadRepo.findOne({ where: { external_id: externalId } });
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
      created_by: lead.created_by ?? lead.assigned_to ?? 1,
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
      created_by: user?.id ?? lead.assigned_to ?? 1,
    });
    await this.followUpRepo.save(fu);
    lead.follow_up_date = due;
    await this.leadRepo.save(lead);
  }
}

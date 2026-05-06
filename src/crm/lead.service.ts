import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  normalizePhone,
  isValidPhone,
  isShopifyPhoneReal,
  toSentenceCase,
  sentenceCaseWords,
} from './normalizers/lead-normalizer';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Lead, LeadSource, LeadStatus, LeadPriority, LeadStage } from './entities/lead.entity';
import { LeadContext, contextToLabel } from './enums/lead-context.enum';
import { LogsService, LogAction } from '../logs/logs.service';
import { LeadNote, NoteType } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { User } from '../users/entities/user.entity';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService, DecisionContext } from './decision-engine.service';
import { LeadAuditService } from './lead-audit.service';
import { QuotationService } from '../quotation/quotation.service';
import { DEDUP } from '../config/config';

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

/**
 * Deterministic idempotency key for a lead.
 * Built from the last-10 digits of the phone + product_interest + context, all normalised.
 * Returns null for anonymous leads (no phone) so every anonymous submission always
 * creates a new lead instead of being collapsed into a previous one.
 */
/** Extracts the first plausible phone number from free-form text and returns it in E.164. */
function extractPhoneFromText(text: string): string | null {
  const matches = text.match(/\+?\d[\d\s-]{8,20}\d/g);
  if (!matches || matches.length === 0) return null;
  const validNumbers = matches
    .map(raw => raw.replace(/\D/g, ''))
    .filter(raw => !raw.startsWith('0') && !/^(\d)\1+$/.test(raw));
  if (validNumbers.length === 0) return null;
  validNumbers.sort((a, b) => b.length - a.length);
  const selected = validNumbers[0];
  const normalized = normalizePhone(selected);
  return normalized && normalized !== 'unknown' ? normalized : null;
}

function generateIdempotencyKey(phone: string | null, dto: Partial<CreateLeadDto>): string | null {
  if (!phone || phone === 'unknown') return null;
  const dateHour = new Date().toISOString().slice(0, 13); // "2026-05-02T15"
  const parts = [
    phone.replace(/\D/g, '').slice(-10),
    (dto.product_interest ?? '').toLowerCase().trim(),
    dateHour,
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Idempotency key for Shopify leads.
 *  Known phone → deterministic hash (deduplicates repeat clicks from same customer).
 *  Unknown phone → unique key per click (every anonymous WhatsApp click is a separate lead). */
function generateShopifyExternalId(payload: {
  phone?: string; action?: string; lead_type?: string; product?: string;
}): string {
  const rawPhone = (payload.phone || '').trim();
  if (!rawPhone || rawPhone.toLowerCase() === 'unknown') {
    return `shopify_anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
  const phone   = normalizePhone(rawPhone).replace(/\D/g, '').slice(-10);
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
    private logsService: LogsService,
    private quotationService: QuotationService,
    private eventEmitter: EventEmitter2,
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

    // Add is_phone_valid column if it doesn't exist yet (safe — has a default so existing rows are unaffected)
    try {
      await this.ds.query(`
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS is_phone_valid BOOLEAN NOT NULL DEFAULT TRUE
      `);
    } catch (e) {
      this.logger.error('Failed to ensure leads.is_phone_valid column', e);
    }

    try {
      await this.ds.query(`
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS last_customer_reply_at TIMESTAMPTZ
      `);
    } catch (e) {
      this.logger.error('Failed to ensure leads.last_customer_reply_at column', e);
    }

    try {
      await this.ds.query(`
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS last_salesman_reply_at TIMESTAMPTZ
      `);
    } catch (e) {
      this.logger.error('Failed to ensure leads.last_salesman_reply_at column', e);
    }

  }

  /** Returns the customer id from customer_phones for the given E.164 phone, or null. */
  private async findCustomerIdByPhone(phone: string | null): Promise<number | null> {
    if (!phone) return null;
    const rows = await this.ds.query<{ customer_id: number }[]>(
      `SELECT customer_id FROM customer_phones WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    return rows.length > 0 ? rows[0].customer_id : null;
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(dto: CreateLeadDto, user: any): Promise<{ lead: Lead; warning?: string }> {
    console.log(`[DEBUG] Creating lead in DB — source=${dto.source} phone=${dto.phone} user_id=${user?.id ?? 'null'}`);

    // Coerce legacy 'MANUAL' source values from older clients / DB rows
    if ((dto.source as string) === 'MANUAL') (dto as any).source = LeadSource.DIRECT;

    // Normalize to E.164 (+91XXXXXXXXXX) before any dedup or DB operation.
    // Anonymous leads (no phone) are allowed — stored as NULL.
    if (dto.phone) {
      dto.phone = normalizePhone(dto.phone);
      if (!dto.phone || dto.phone === 'unknown' || !isValidPhone(dto.phone)) {
        throw new BadRequestException('A valid phone number is required (e.g. 9876543210 or +919876543210).');
      }
    }
    const storedPhone = dto.phone || null;

    if (dto.external_id) {
      const existing = await this.findByExternalId(dto.external_id);
      if (existing) return { lead: existing };
    }

    // ── Idempotency gate: same phone + product_interest + hour within 10 min ──
    // Catches event storms and double-submissions before the heavier phone dedup.
    const idempotencyKey = generateIdempotencyKey(storedPhone, dto);
    if (idempotencyKey) {
      const idemRows = await this.ds.query<Lead[]>(
        `SELECT * FROM leads
         WHERE idempotency_key = $1
           AND is_active = true
           AND created_at >= NOW() - INTERVAL '10 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [idempotencyKey],
      );
      if (idemRows.length > 0) {
        this.logger.log(
          `Idempotency hit key=${idempotencyKey.slice(0, 8)}… → returning lead id=${idemRows[0].id}`,
        );
        return { lead: idemRows[0] };
      }
    }

    // ── Strict phone dedup: any existing lead for this phone → enrich, not create
    // Anonymous leads (no phone) always create a new row.
    if (storedPhone) {
      const rows = await this.ds.query<Lead[]>(
        `SELECT * FROM leads
         WHERE phone = $1
           AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [storedPhone],
      );

      if (rows.length > 0) {
        const existing: Lead = rows[0];
        const patch: Partial<Lead> = {};

        // Append requirement_note; never overwrite prior content.
        const mergedNote = [existing.requirement_note, dto.requirement_note]
          .filter(Boolean)
          .join('\n---\n') || undefined;
        if (mergedNote && mergedNote !== existing.requirement_note) {
          patch.requirement_note = mergedNote;
        }

        // Fill product_interest only when the existing lead has none.
        if (!existing.product_interest && dto.product_interest) {
          patch.product_interest = sentenceCaseWords(dto.product_interest);
        }

        // Accumulate all context labels in contextHistory TEXT[].
        const mergedHistory = Array.from(new Set([
          ...(existing.contextHistory || []),
          ...(dto.context ? [dto.context] : []),
        ]));
        if (mergedHistory.length > (existing.contextHistory || []).length) {
          patch.contextHistory = mergedHistory;
        }

        // context = latest touch-point only.
        // context_history = full pipe-separated journey, deduped, newest at end.
        if (dto.context) {
          patch.context = dto.context;
          const historyParts = (existing.context_history || '').split(' | ').map(s => s.trim()).filter(Boolean);
          if (!historyParts.includes(dto.context)) {
            patch.context_history = [...historyParts, dto.context].join(' | ');
          }
        }

        // Link customer if not already set and a matching customer exists.
        if (!existing.customer_id) {
          const linkedCustomerId = await this.findCustomerIdByPhone(storedPhone);
          if (linkedCustomerId) patch.customer_id = linkedCustomerId;
        }

        if (Object.keys(patch).length > 0) {
          await this.leadRepo.update(existing.id, patch);
        }

        const updated = (await this.leadRepo.findOne({ where: { id: existing.id } })) ?? existing;
        this.logger.log(
          `Phone dedup: enriched lead id=${existing.id} phone=${storedPhone}` +
          (Object.keys(patch).length ? ` — patched: ${Object.keys(patch).join(', ')}` : ' — no changes'),
        );
        return { lead: updated };
      }
    }

    // Normalize empty-string context to undefined so the DB stores NULL, not ''.
    if ((dto as any).context === '') (dto as any).context = undefined;

    // Default context for manual (DIRECT) leads when not supplied by the client.
    if (!dto.context && dto.source === LeadSource.DIRECT) {
      (dto as any).context = contextToLabel(LeadContext.DIRECT_MANUAL);
    }

    let assignedTo = dto.assigned_to;
    if (!assignedTo) {
      assignedTo = await this.assignmentService.getNextAssignee(dto.source) ?? undefined;
      if (!assignedTo) {
        this.logger.warn(`No eligible telecaller found for source=${dto.source} — lead will be unassigned`);
      }
    }

    const dupCount = storedPhone
      ? await this.leadRepo.count({ where: { phone: storedPhone, is_active: true } })
      : 0;

    // Link to existing customer if phone is already registered.
    const linkedCustomerId = await this.findCustomerIdByPhone(storedPhone);

    const lead = this.leadRepo.create({
      ...dto,
      name: (dto.name && dto.name !== 'Unknown' && dto.name !== 'Unknown Lead')
        ? sentenceCaseWords(dto.name)
        : 'Customer',
      phone: storedPhone as any,
      notes: dto.notes != null && dto.notes !== '' ? toSentenceCase(dto.notes) : undefined,
      product_interest: dto.product_interest != null && dto.product_interest !== '' ? sentenceCaseWords(dto.product_interest) : undefined,
      assigned_to: assignedTo,
      created_by: user?.id,
      duplicate_flag: dupCount > 0,
      idempotency_key: idempotencyKey ?? undefined,
      contextHistory: dto.context ? [dto.context] : [],
      context_history: dto.context ?? undefined,
      customer_id: linkedCustomerId ?? undefined,
      whatsappMessageId: dto.whatsappMessageId,
      hasSerializedId: dto.hasSerializedId ?? false,
    });

    console.log('Saving lead with messageId:', lead.whatsappMessageId);

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

    let saved: Lead;
    try {
      saved = await this.leadRepo.save(lead);
    } catch (err: any) {
      // Race condition: two concurrent requests both passed the phone dedup check
      // and both tried to insert. The partial unique index on phone catches the loser.
      if (err.code === '23505' && storedPhone) {
        this.logger.warn(
          `Race condition on phone=${storedPhone} — unique index caught duplicate, fetching existing lead`,
        );
        const rows = await this.ds.query<Lead[]>(
          `SELECT * FROM leads WHERE phone = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
          [storedPhone],
        );
        if (rows.length > 0) return { lead: rows[0] };
      }
      throw err;
    }

    this.logger.log(
      `Lead created id=${saved.id} phone=${storedPhone} source=${dto.source} assigned_to=${assignedTo ?? 'none'}${dupCount > 0 ? ' [DUPLICATE]' : ''}${this._whatsappDown ? ' [WA_FALLBACK]' : ''}`,
    );
    this.logsService.log(
      LogAction.LEAD_CREATED,
      { leadId: saved.id, phone: storedPhone, source: dto.source, assigned_to: assignedTo ?? null, duplicate: dupCount > 0 },
      user?.id ?? null,
    );

    this.eventEmitter.emit('crm.lead.created', {
      id:               saved.id,
      name:             saved.name,
      phone:            saved.phone ?? null,
      source:           saved.source,
      assigned_to:      saved.assigned_to ?? null,
      product_interest: saved.product_interest ?? null,
    });

    await this.scheduleFirstFollowUp(saved);

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
      let saved = await this.leadRepo.save(lead);

      void this.auditService.log(id, user.id, 'STATUS_CHANGED', `${prevStatus} → ${saved.status}`, ip);

      if (prevStatus !== saved.status) {
        this.eventEmitter.emit('crm.lead.status_changed', {
          id:               saved.id,
          name:             saved.name,
          phone:            saved.phone ?? null,
          assigned_to:      saved.assigned_to ?? null,
          prev_status:      prevStatus,
          new_status:       saved.status,
          product_interest: saved.product_interest ?? null,
        });

        await this.autoScheduleFollowUp(saved, saved.status as LeadStatus, user);
        const targetStage = this.computeTargetStageForStatus(saved.stage, saved.status as LeadStatus);
        if (targetStage) {
          saved = await this.updateStage(saved.id, targetStage, user);
        }
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

  async assignLead(id: number, userId: number | null, user: any, ip?: string): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const managerRoles = ['Admin', 'COO', 'Sales Manager'];
    if (!managerRoles.includes(user?.role)) {
      this.assertAccess(lead, user);
    }

    if (userId === null) {
      lead.assigned_to = null as any;
      const saved = await this.leadRepo.save(lead);
      void this.auditService.log(id, user.id, 'ASSIGNED', '→ Unassigned', ip);
      return saved;
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
    const saved = await this.noteRepo.save(note);
    await this.tryKeywordAdvance(lead, body.note, user);
    return saved;
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
    await this.tryKeywordAdvance(lead, body.note, user);
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

    // Look up customer via customer_phones index (global unique phone registry)
    const e164   = lead.phone ?? null;
    const bare10 = lead.phone ? lead.phone.replace(/\D/g, '').slice(-10) : null;
    const existing = e164 ? await this.leadRepo.manager.query(
      `SELECT c.id, c."companyName", c."contactName", c.mobile1, c.email, c.city
       FROM customer_phones cp
       JOIN customer c ON c.id = cp.customer_id
       WHERE cp.phone = $1 OR cp.phone = $2
       LIMIT 1`,
      [e164, bare10],
    ) : [];

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

  /** One-click conversion: find-or-create customer, mark lead CONVERTED, return customerId. */
  async quickConvert(id: number, user: any, ip?: string): Promise<{ customerId: number; isNew: boolean }> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Already converted — return existing customer id
    if (lead.status === LeadStatus.CONVERTED && lead.customer_id) {
      return { customerId: lead.customer_id, isNew: false };
    }

    const e164   = lead.phone ?? null;
    const bare10 = lead.phone ? lead.phone.replace(/\D/g, '').slice(-10) : null;
    let customerId: number | null = null;
    let isNew = false;

    // 1. Find existing customer via customer_phones index (covers mobile1 + mobile2)
    if (e164) {
      const rows = await this.leadRepo.manager.query(
        `SELECT customer_id AS id FROM customer_phones
         WHERE phone = $1 OR phone = $2
         LIMIT 1`,
        [e164, bare10],
      );
      if (rows.length > 0) customerId = rows[0].id;
    }

    // 2. Create minimal customer if none found; register phone in customer_phones
    if (!customerId) {
      const name  = toSentenceCase(lead.name || 'Unknown');
      const phone = e164 || bare10 || null;
      const city  = lead.city  || 'TBD';
      const state = lead.state || 'TBD';

      const inserted = await this.leadRepo.manager.query(
        `INSERT INTO customer ("companyName", "contactName", mobile1, city, state, pincode, "customerType", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (mobile1) DO UPDATE SET "contactName" = EXCLUDED."contactName"
         RETURNING id`,
        [name, name, phone, city, state, '000000', 'Retail Shop', String(user.id)],
      );
      customerId = inserted[0].id;
      isNew = true;

      // Register phone in the global index so future lookups hit customer_phones
      if (phone) {
        await this.leadRepo.manager.query(
          `INSERT INTO customer_phones (customer_id, phone)
           VALUES ($1, $2)
           ON CONFLICT (phone) DO NOTHING`,
          [customerId, phone],
        );
      }
    }

    // 3. Mark lead as CONVERTED
    lead.status      = LeadStatus.CONVERTED;
    lead.customer_id = customerId;
    await this.leadRepo.save(lead);
    void this.auditService.log(id, user.id, 'CONVERTED', `customer_id=${customerId} isNew=${isNew}`, ip);

    return { customerId, isNew };
  }

  private static readonly QUALIFIED_KEYWORDS = /price|cost|quotation/i;

  /** If note text contains buying-intent keywords and lead is at CONTACTED, advance to QUALIFIED. */
  private async tryKeywordAdvance(lead: Lead, text: string | undefined, user: any): Promise<void> {
    if (!text || lead.stage !== LeadStage.CONTACTED) return;
    if (!LeadService.QUALIFIED_KEYWORDS.test(text)) return;
    await this.updateStage(lead.id, LeadStage.QUALIFIED, user);
  }

  /** Returns the LeadStage implied by a status transition, or null if no stage sync is needed. */
  private computeTargetStageForStatus(currentStage: LeadStage, newStatus: LeadStatus): LeadStage | null {
    if (currentStage === LeadStage.WON || currentStage === LeadStage.LOST) return null;
    if (newStatus === LeadStatus.QUOTATION) return LeadStage.QUOTED;
    if (newStatus === LeadStatus.CONVERTED) return LeadStage.WON;
    if (newStatus === LeadStatus.LOST) return LeadStage.LOST;
    return null;
  }

  // Linear forward-only progression. LOST is a lateral terminal exit handled separately.
  private static readonly STAGE_ORDER: readonly LeadStage[] = [
    LeadStage.NEW,
    LeadStage.CONTACTED,
    LeadStage.QUALIFIED,
    LeadStage.QUOTED,
    LeadStage.WON,
  ];

  /**
   * Advance a lead's stage with auto-stepping for skipped stages.
   *
   * - NEW → QUALIFIED  becomes  NEW → CONTACTED → QUALIFIED  (two saves, both logged)
   * - Any downgrade (e.g. QUALIFIED → NEW) is rejected.
   * - WON and LOST are terminal — no transitions out.
   * - Transitioning to LOST is always valid from any non-terminal stage.
   */
  async updateStage(id: number, newStage: LeadStage, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const currentStage = lead.stage ?? LeadStage.NEW;

    // Terminal stages cannot be exited
    if (currentStage === LeadStage.WON || currentStage === LeadStage.LOST) {
      throw new BadRequestException(
        `Lead is in terminal stage ${currentStage} and cannot be advanced.`,
      );
    }

    // LOST is always a valid lateral exit from any active stage
    if (newStage === LeadStage.LOST) {
      lead.stage = LeadStage.LOST;
      const saved = await this.leadRepo.save(lead);
      this.logger.log(`[CRM] Stage: ${currentStage} → ${LeadStage.LOST} (lead=${id} by user=${user.id})`);
      return saved;
    }

    const order       = LeadService.STAGE_ORDER;
    const currentIdx  = order.indexOf(currentStage);
    const targetIdx   = order.indexOf(newStage);

    if (targetIdx === -1) {
      throw new BadRequestException(`Unknown stage: ${newStage}`);
    }

    // Reject downgrades
    if (targetIdx < currentIdx) {
      throw new BadRequestException(
        `Cannot downgrade stage from ${currentStage} to ${newStage}.`,
      );
    }

    // Already at target — no-op
    if (targetIdx === currentIdx) return lead;

    // Walk forward through each intermediate stage, persisting every step
    let saved: Lead = lead;
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const prev = saved.stage;
      saved.stage = order[i];
      saved = await this.leadRepo.save({ ...saved });
      this.logger.log(
        `[CRM] Stage: ${prev} → ${saved.stage} (lead=${id} by user=${user.id}${i < targetIdx ? ' [auto-step]' : ''})`,
      );
    }

    return saved;
  }

  async markConverted(id: number, customerId: number, quotationId: number, user: any, ip?: string): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    lead.status = LeadStatus.CONVERTED;
    lead.customer_id = customerId;
    lead.quotation_id = quotationId;
    let saved = await this.leadRepo.save(lead);

    if (saved.stage !== LeadStage.LOST && saved.stage !== LeadStage.WON) {
      saved = await this.updateStage(id, LeadStage.WON, user);
    }

    void this.auditService.log(id, user.id, 'CONVERTED', `customer_id=${customerId} quotation_id=${quotationId}`, ip);
    return saved;
  }

  /** Entry-point for Shopify theme JS events (POST /api/leads/shopify).
   *  Routes through the standard create() so dedup, assignment, and follow-up all apply. */
  async createFromShopifyClick(payload: {
    source?: string; action?: string; name?: string; phone?: string;
    email?: string; city?: string; country?: string; context?: string;
    message?: string; product?: string; product_title?: string; product_url?: string;
    page_url?: string; lead_type?: string; priority?: string; timestamp?: string;
    tag?: string;
  }): Promise<{ ok: boolean; leadId?: number; error?: string }> {
    console.log('📥 SERVICE PAYLOAD:', JSON.stringify(payload));

    const externalId = generateShopifyExternalId(payload);

    const rawName    = (payload.name || '').trim();
    const rawEmail   = (payload.email || '').trim();
    const rawCity    = (payload.city || '').trim();
    const rawCountry = (payload.country || '').trim();
    const rawContext = (payload.context || '').trim();

    // Validate phone: reject empty, too-short, and all-same-digit fakes (0000000000, 9999999999…)
    const phoneIsReal     = isShopifyPhoneReal(payload.phone ?? '');
    const normalizedPhone = phoneIsReal ? normalizePhone(payload.phone ?? '') : 'unknown';
    const resolvedPhone   = phoneIsReal && normalizedPhone !== 'unknown' ? normalizedPhone : undefined;

    const leadData: CreateLeadDto = {
      name:              rawName    || undefined,
      phone:             resolvedPhone,
      is_phone_valid:    phoneIsReal,
      email:             rawEmail   || undefined,
      city:              rawCity    || undefined,
      country:           rawCountry || undefined,
      // Use a Shopify-specific fallback so leads with no action/context never get 'DIRECT – Manual Entry'.
      context:           contextToLabel(rawContext || payload.action || LeadContext.SHOPIFY_PRODUCT_FORM),
      product_interest:  payload.product || payload.product_title || payload.page_url || 'General Inquiry',
      notes:             payload.message ? payload.message : `Lead from ${payload.page_url || ''}`,
      source:            LeadSource.SHOPIFY,
      lead_source_label: contextToLabel(rawContext || payload.action || LeadContext.SHOPIFY_PRODUCT_FORM),
      landing_page:      payload.page_url || '',
      external_id:       externalId,
      raw_payload:       {
        ...payload,
        last_message:    payload.message || '',
        last_message_at: new Date().toISOString(),
      },
    };

    console.log('📧 EMAIL:', leadData.email);
    console.log('🚨 FINAL SANITY CHECK:', {
      phone:   leadData.phone,
      email:   leadData.email,
      product: leadData.product_interest,
      context: leadData.context,
    });

    // ── Time-based idempotency ────────────────────────────────────────────────
    // Same phone + same product within 30 min → touch updated_at and return.
    // Prevents duplicate CRM entries from repeated button/form interactions.
    const recentDup = await this.findRecentShopifyDuplicate(
      resolvedPhone ?? null,
      leadData.product_interest ?? '',
      LeadSource.SHOPIFY,
    );
    if (recentDup) {
      const existingRp =
        recentDup.raw_payload && typeof recentDup.raw_payload === 'object' && !Array.isArray(recentDup.raw_payload)
          ? recentDup.raw_payload
          : {};
      await this.leadRepo.update(recentDup.id, {
        raw_payload: {
          ...existingRp,
          last_message:    payload.message || existingRp['last_message'] || '',
          last_message_at: new Date().toISOString(),
        } as any,
      });
      this.logger.log(
        `Shopify duplicate suppressed — returning existing lead id=${recentDup.id} (within 30-min window)`,
      );
      return { ok: true, leadId: recentDup.id };
    }

    try {
      const { lead } = await this.create(leadData, { id: null, role: 'Admin' });
      console.log('LEAD CREATED:', { id: lead.id, phone: lead.phone, source: lead.source });
      this.logger.log(`Shopify lead id=${lead.id} external_id=${externalId}`);
      if (!phoneIsReal) {
        try {
          await this.addNote(lead.id, { note: 'Phone not provided from Shopify', type: NoteType.GENERAL }, { id: null, role: 'Admin' });
        } catch { /* note failure must not block lead creation */ }
      }
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
      this.logsService.log(LogAction.ERROR, { context: 'createFromShopifyClick', message: e?.message, payload });
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

  @OnEvent('lead.incoming', { async: true })
  async handleIncomingLead(payload: {
    phone: string;
    name: string;
    source: LeadSource;
    whatsapp_chat_id?: string;
    raw_payload?: any;
    external_id?: string;
    messageId?: string;
    hasSerializedId?: boolean;
  }): Promise<void> {
    console.log('LEAD SERVICE RECEIVED:', payload);
    try {
      const { messageId } = payload;
      const normalized = normalizePhone(payload.phone ?? '');
      const phone = normalized === 'unknown' ? undefined : normalized;

      if (!phone) {
        this.logger.warn({
          action: 'WHATSAPP_NO_PHONE',
          rawPhone: payload.phone ?? null,
          messageId: messageId ?? null,
        });
      }

      // Stage 0: exact message-ID dedup — durable across restarts, blocks event storms
      if (messageId) {
        const existingByMsgId = await this.leadRepo.findOne({
          where: { whatsappMessageId: messageId },
        });
        if (existingByMsgId) {
          this.logger.log({
            action: 'WHATSAPP_DUPLICATE_SKIPPED',
            messageId: messageId,
            existingLeadId: existingByMsgId.id,
          });
          return;
        }
      }

      const existing = await this.findRecentWhatsAppLead(phone);

      if (existing) {
        // Append the new message to notes rather than creating a duplicate row
        const incomingMessage: string = payload.raw_payload?.body ?? payload.raw_payload?.message ?? '';
        if (incomingMessage) {
          const timestamp = new Date().toISOString();
          const appendLine = `\n[${timestamp}] ${incomingMessage}`;
          const safePayload =
            existing.raw_payload &&
            typeof existing.raw_payload === 'object' &&
            !Array.isArray(existing.raw_payload)
              ? existing.raw_payload
              : {};

          await this.leadRepo.update(existing.id, {
            notes: (existing.notes ?? '') + appendLine,
            raw_payload: {
              ...safePayload,
              last_message: incomingMessage,
              last_message_at: timestamp,
            } as any,
          });
        } else {
          await this.leadRepo.update(existing.id, { updated_at: new Date() });
        }

        if (!existing.phone && incomingMessage) {
          const extracted = extractPhoneFromText(incomingMessage);
          if (extracted) {
            await this.leadRepo.update(existing.id, { phone: extracted });
            this.logger.log({ action: 'PHONE_EXTRACTED_FROM_CHAT', leadId: existing.id, phone: extracted });
          }
        }

        this.logger.log(
          `WhatsApp dedup — phone=${phone} merged into lead id=${existing.id} (within 5-min window)`,
        );
        return;
      }

      const rp = payload.raw_payload ?? {};
      // Enrich from raw_payload when WhatsApp contact info is richer than the emitted payload
      const enrichedName  = payload.name || rp.pushname || rp.name || rp.contact_name || undefined;
      const enrichedCity  = rp.city || rp.location || undefined;
      const inboundBody   = rp.body || rp.message || '';
      const timestamp     = new Date().toISOString();

      const dto: CreateLeadDto = {
        phone,                          // undefined for invalid/missing phones → anonymous lead
        name:               enrichedName,
        city:               enrichedCity,
        source:             payload.source,
        context:            contextToLabel(LeadContext.WHATSAPP_INBOUND),
        whatsapp_chat_id:   payload.whatsapp_chat_id,
        notes:              inboundBody || undefined,
        raw_payload:        {
          ...rp,
          raw_phone:       payload.phone ?? null,  // preserve original for analytics
          last_message:    inboundBody || null,
          last_message_at: timestamp,
        },
        external_id:        payload.external_id,
        channel:            'WHATSAPP',
        lead_source_label:  'inbound_message',
        whatsappMessageId:  messageId,
        hasSerializedId:    payload.hasSerializedId ?? false,
      };

      console.log('Saving lead with messageId:', dto.whatsappMessageId);

      try {
        const { lead: savedLead } = await this.create(dto, { id: null, role: 'Admin' });

        if (!savedLead.phone && inboundBody) {
          const extracted = extractPhoneFromText(inboundBody);
          if (extracted) {
            await this.leadRepo.update(savedLead.id, { phone: extracted });
            this.logger.log({ action: 'PHONE_EXTRACTED_FROM_CHAT', leadId: savedLead.id, phone: extracted });
          }
        }

        this.logger.log({
          action:    'WHATSAPP_LEAD_CREATED',
          phone,
          messageId: messageId ?? null,
        });
      } catch (err: any) {
        if (err?.code === '23505' && messageId) {
          this.logger.warn({
            action:    'WHATSAPP_DUPLICATE_DB_BLOCKED',
            messageId: messageId,
          });
          await this.leadRepo.findOne({ where: { whatsappMessageId: messageId } });
          return;
        }
        throw err;
      }
    } catch (e) {
      this.logger.error(`handleIncomingLead failed for phone=${normalizePhone(payload.phone ?? '')}: ${e?.message}`, e?.stack);
    }
  }

  /** Returns the most recent active WHATSAPP lead for this phone within the configured dedup window. */
  private async findRecentWhatsAppLead(phone: string): Promise<Lead | null> {
    if (!phone || phone === 'unknown') return null;

    const rows: Lead[] = await this.ds.query(
      `SELECT * FROM leads
       WHERE phone = $1
         AND source = 'WHATSAPP'
         AND is_active = true
         AND created_at > NOW() - INTERVAL '1 minute' * $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone, DEDUP.PHONE_WINDOW_MINUTES],
    );

    return rows.length > 0 ? rows[0] : null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Time-based idempotency for Shopify leads.
   * Returns an existing active lead if the same normalised phone + product_interest
   * was submitted within the last 30 minutes. Unknown phone is excluded — every
   * anonymous click is always a new lead.
   */
  private async findRecentShopifyDuplicate(
    phone: string | null,
    productInterest: string,
    source: string,
  ): Promise<Lead | null> {
    if (phone && phone !== 'unknown') {
      // Phone-based dedup: 30-min window
      const windowStart = new Date(Date.now() - 30 * 60 * 1000);
      const rows: Lead[] = await this.ds.query(
        `SELECT * FROM leads
         WHERE phone = $1
           AND product_interest = $2
           AND source = 'SHOPIFY'
           AND is_active = true
           AND created_at >= $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [phone, productInterest, windowStart],
      );
      return rows.length > 0 ? rows[0] : null;
    }

    // Fallback for null-phone leads: same product + same source within 10 min
    const windowStart = new Date(Date.now() - 10 * 60 * 1000);
    const rows: Lead[] = await this.ds.query(
      `SELECT * FROM leads
       WHERE phone IS NULL
         AND product_interest = $1
         AND source = $2
         AND is_active = true
         AND created_at >= $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [productInterest, source, windowStart],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async createQuotationFromLead(id: number, user: any, ip?: string): Promise<any> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const quotation = await this.quotationService.create(
      {
        lead_id:          lead.id,
        customer_name:    lead.name,
        salesman_id:      user?.id,
        items:            [],
      },
      user,
    );

    // Link quotation back to the lead
    await this.leadRepo.update(id, { quotation_id: quotation.id });

    // Advance stage to QUOTED if not already there or past it
    const advanceable: LeadStage[] = [LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUALIFIED];
    if (advanceable.includes(lead.stage)) {
      await this.updateStage(id, LeadStage.QUOTED, user);
    }

    void this.auditService.log(id, user.id, 'QUOTATION_CREATED', `quotation_id=${quotation.id}`, ip);

    return quotation;
  }

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
    let hoursAhead: number | null = null;
    let noteText: string | null = null;

    if (newStatus === LeadStatus.CONTACTED) {
      // Hot inbound sources: first follow-up in 4h — they just expressed intent
      const hotSources: string[] = [LeadSource.META, LeadSource.GOOGLE, LeadSource.LINKEDIN];
      if (hotSources.includes(lead.source as string)) {
        hoursAhead = 4;
        noteText = 'Auto-scheduled: quick follow up (hot inbound lead)';
      } else if (lead.source === LeadSource.INDIAMART) {
        hoursAhead = 24;
        noteText = 'Auto-scheduled: follow up after first contact';
      } else {
        hoursAhead = 48;
        noteText = 'Auto-scheduled: follow up after first contact';
      }
    } else if (newStatus === LeadStatus.INTERESTED) {
      hoursAhead = 24;
      noteText = 'Auto-scheduled: send quotation';
    } else if (newStatus === LeadStatus.QUOTATION) {
      hoursAhead = 72;
      noteText = 'Auto-scheduled: follow up on quotation';
    }

    if (!hoursAhead) return;

    const due = new Date();
    due.setTime(due.getTime() + hoursAhead * 60 * 60 * 1000);
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

  // ── Automation settings ──────────────────────────────────────────────────────

  private static readonly AUTOMATION_KEYS = [
    'automation.lead_greeting',
    'automation.followup_reminders',
    'automation.payment_followups',
  ] as const;

  async getAutomationSettings(): Promise<Record<string, string | boolean>> {
    // Returns automation toggles (bool) + cron last-run timestamps (string ISO)
    const rows: { key: string; value: string }[] = await this.ds.query(
      `SELECT key, value FROM crm_settings
       WHERE key LIKE 'automation.%' OR key LIKE 'cron.%'`,
    );
    const map: Record<string, string | boolean> = {
      'automation.lead_greeting':      true,
      'automation.followup_reminders': true,
      'automation.payment_followups':  true,
    };
    for (const row of rows) {
      if (row.key.startsWith('automation.')) {
        map[row.key] = row.value !== 'false';
      } else {
        map[row.key] = row.value;   // ISO timestamp strings, returned as-is
      }
    }
    return map;
  }

  async updateAutomationSettings(settings: Record<string, boolean>): Promise<Record<string, string | boolean>> {
    for (const key of LeadService.AUTOMATION_KEYS) {
      if (key in settings) {
        await this.ds.query(
          `INSERT INTO crm_settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, String(settings[key])],
        );
      }
    }
    return this.getAutomationSettings();
  }

  async setAutomationPaused(id: number, paused: boolean): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    if (paused) {
      if (!tags.includes('automation_off')) lead.tags = [...tags, 'automation_off'];
    } else {
      lead.tags = tags.filter(t => t !== 'automation_off');
    }
    return this.leadRepo.save(lead);
  }
}

import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  normalizePhone,
  isShopifyPhoneReal,
  normalizeIdentityField,
  normalizePhoneForIdentity,
  normalizeRequirement,
  toSentenceCase,
  sentenceCaseWords,
} from './normalizers/lead-normalizer';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Lead, LeadSource, LeadStatus, LeadPriority, LeadStage, LeadQuality, WorkflowState, OutcomeType } from './entities/lead.entity';

/**
 * Manual / high-trust sources where phone is optional.
 * These represent physical or relationship-based lead captures —
 * the person's presence or referral already provides trust context.
 * Leads from these sources are still created even with no phone or email,
 * but are NOT auto-assigned to telecallers (requires phone for call queue).
 */
const MANUAL_TRUST_SOURCES = new Set<LeadSource>([
  LeadSource.WALK_IN,
  LeadSource.REFERRAL,
  LeadSource.EXHIBITION,
  LeadSource.FIELD_VISIT,
  LeadSource.OLD_CUSTOMER,
  LeadSource.DEALER_REFERENCE,
  LeadSource.BUSINESS_CARD,
  LeadSource.IMPORTED,
  LeadSource.DIRECT,
]);
import { LeadContext, contextToLabel } from './enums/lead-context.enum';
import { LogsService, LogAction } from '../logs/logs.service';
import { LeadNote, NoteType } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { User } from '../users/entities/user.entity';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';
import { DecisionEngineService, DecisionContext, OutcomeHistory, computeNextActionDue, computeSlaStatus, computeQueueTier, isValidWorkflowTransition, WORKFLOW_RANK } from './decision-engine.service';
import { IsNull } from 'typeorm';
import { LeadAuditService } from './lead-audit.service';
import { QuotationService } from '../quotation/quotation.service';
import { DEDUP } from '../config/config';
import { CRM_FULL_ACCESS_ROLES, CRM_WORKFLOW_BYPASS_ROLES, CRM_NON_OPERATIONAL_QUALITIES, hasOperationalIdentity, hasContactInfo } from './crm.constants';

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

// Re-exported from crm.constants.ts for use inside this file.
// CRM_WORKFLOW_BYPASS_ROLES intentionally excludes 'Sales Manager' — see crm.constants.ts.
const WORKFLOW_BYPASS_ROLES = CRM_WORKFLOW_BYPASS_ROLES;

/** Result of LeadService.create() — CRM row or analytics-only routing. */
export type LeadCreateResult = {
  lead?: Lead;
  warning?: string;
  analyticsOnly?: boolean;
  blocked?: boolean;
  reason?: string;
};

// Workflow states that must not be rolled back by a status change.
// If the lead is already in one of these states and the target rank is lower,
// the workflow_state update is skipped (status change still goes through).
const PROTECTED_WORKFLOW_STATES = new Set<WorkflowState>([
  WorkflowState.SEND_QUOTATION,
  WorkflowState.CHASE_QUOTATION,
  WorkflowState.NEGOTIATING,
  WorkflowState.CONVERTED,
]);

// States where a lead MUST have at least one identity field (phone or email).
// Terminal/passive states (CONVERTED, LOST, NURTURE) are exempt from the identity gate.
const OPERATIONAL_WORKFLOW_STATES = new Set<WorkflowState>([
  WorkflowState.FIRST_CALL,
  WorkflowState.FOLLOW_UP,
  WorkflowState.NO_ANSWER_1,
  WorkflowState.NO_ANSWER_2,
  WorkflowState.NO_ANSWER_ESC,
  WorkflowState.CALLBACK_WAIT,
  WorkflowState.SEND_QUOTATION,
  WorkflowState.CHASE_QUOTATION,
  WorkflowState.NEGOTIATING,
]);

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

/**
 * Resolve the context label for a Shopify click lead.
 *
 * Priority order:
 *   1. Explicit context / action from the frontend form
 *   2. Google click ID (gclid) → GOOGLE – Ads
 *   3. Facebook click ID (fbclid) → META – Campaign
 *   4. utm_source signal → platform-specific label
 *   5. Default → SHOPIFY – Product Form
 *
 * UTM data is always stored verbatim in raw_payload regardless of this function.
 */
function resolveShopifyUtmContext(
  rawContext: string,
  payload: {
    action?: string;
    utm_source?: string; utm_medium?: string; utm_campaign?: string;
    gclid?: string; fbclid?: string;
  },
): string {
  // Explicit context from the form takes precedence over UTM signals
  if (rawContext) return contextToLabel(rawContext);
  if (payload.action) return contextToLabel(payload.action);

  const src = (payload.utm_source || '').toLowerCase();
  const med = (payload.utm_medium || '').toLowerCase();

  if (payload.gclid || src.includes('google')) {
    if (payload.gclid || med === 'cpc' || med === 'ppc')
      return contextToLabel(LeadContext.GOOGLE_ADS);
    return contextToLabel(LeadContext.GOOGLE_ORGANIC);
  }
  if (payload.fbclid || src.match(/meta|facebook|fb|instagram/)) {
    return contextToLabel(LeadContext.META_LEAD_FORM);
  }

  return contextToLabel(LeadContext.SHOPIFY_PRODUCT_FORM);
}

@Injectable()
export class LeadService implements OnModuleInit {
  private readonly logger = new Logger(LeadService.name);

  // Tracks WhatsApp connectivity via event bus — set/cleared by whatsapp.down / whatsapp.up.
  // No direct import of WhatsAppService needed (avoids CrmModule ↔ WhatsappModule coupling).
  private _whatsappDown = false;

  // ── Lead lock map (memory-only, 15-min TTL, Admin/COO bypass) ─────────────────
  private readonly leadLockMap = new Map<number, { userId: number; userName: string; lockedUntil: number }>();

  acquireLock(leadId: number, user: any): void {
    this.leadLockMap.set(leadId, {
      userId:      user.id,
      userName:    user.name ?? 'Unknown',
      lockedUntil: Date.now() + 15 * 60_000,
    });
  }

  getLockInfo(leadId: number): { userId: number; userName: string; lockedUntil: number } | null {
    const entry = this.leadLockMap.get(leadId);
    if (!entry) return null;
    if (Date.now() > entry.lockedUntil) { this.leadLockMap.delete(leadId); return null; }
    return entry;
  }

  releaseLock(leadId: number, user: any): boolean {
    const lock = this.leadLockMap.get(leadId);
    if (!lock) return true;
    const isBypass = (CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role);
    if (lock.userId !== user?.id && !isBypass) return false;
    this.leadLockMap.delete(leadId);
    return true;
  }

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
    // Runtime safety probe: missing columns cause silent failures in createFromShopifyClick
    // (errors are swallowed so the Shopify theme JS gets a clean response). This makes
    // the problem immediately visible at startup instead.
    //
    // All schema migrations and data backfills have been moved to:
    //   scripts/migrate-crm-phase20-1-startup-cleanup.js
    // Run that script once per environment after deploying Phase 20.1.
    try {
      await this.ds.query(`SELECT tags FROM leads LIMIT 0`);
    } catch {
      this.logger.error(
        '┌─────────────────────────────────────────────────────────────────────┐\n' +
        '│  MIGRATION REQUIRED — leads.tags column is missing                  │\n' +
        '│  Run: node scripts/migrate-crm-phase20-1-startup-cleanup.js         │\n' +
        '└─────────────────────────────────────────────────────────────────────┘',
      );
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

  async create(dto: CreateLeadDto, user: any): Promise<LeadCreateResult> {

    // @deprecated Coercion guard for legacy 'MANUAL' source value — no current client sends this.
    // Safe to remove once confirmed no MANUAL rows exist in production DB.
    // Check: SELECT COUNT(*) FROM leads WHERE source = 'MANUAL'
    if ((dto.source as string) === 'MANUAL') (dto as any).source = LeadSource.DIRECT;

    const identityNorm = this.applyIdentityNormalization(dto);
    const storedPhone = identityNorm.phone;
    const storedEmail = identityNorm.email;
    (dto as any).phone = storedPhone ?? undefined;
    (dto as any).email = storedEmail ?? undefined;

    // Global identity gate — no CRM row without phone or email
    if (!storedPhone && !storedEmail) {
      const reason = 'no_phone_no_email';
      this.logger.warn(
        `[IDENTITY_BLOCKED] source=${dto.source} reason=${reason} context=${dto.context ?? dto.lead_source_label ?? 'n/a'} ts=${new Date().toISOString()}`,
      );
      await this.storeAsAnalyticsEventFromDto(dto, reason);
      return { analyticsOnly: true, blocked: true, reason };
    }

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

    // ── Requirement-aware phone dedup ──────────────────────────────────────────
    // A new submission is the SAME opportunity only when ALL match:
    //   1. same phone (already normalised to E.164)
    //   2. same normalised product_interest (or both empty)
    //   3. same source/platform
    //   4. existing lead is still active (is_active = true)
    // Any mismatch means a NEW opportunity for the same customer — do not merge.
    if (storedPhone) {
      const rows = await this.ds.query<Lead[]>(
        `SELECT * FROM leads
         WHERE phone = $1
           AND is_active = true
         ORDER BY created_at DESC LIMIT 10`,
        [storedPhone],
      );

      if (rows.length > 0) {
        const normNewReq = normalizeRequirement(dto.product_interest);

        // Find an active lead that matches on requirement + source.
        const matchingLead = rows.find((row) => {
          const normExistingReq = normalizeRequirement(row.product_interest);
          return normNewReq === normExistingReq && row.source === dto.source;
        }) ?? null;

        if (matchingLead) {
          const existing: Lead = matchingLead;
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

          // context = latest touch-point; context_history = full pipe-separated journey.
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
            `[RETURNING_CUSTOMER] lead=${existing.lead_ref ?? existing.id} phone=${storedPhone} src=${dto.source} req="${normNewReq.slice(0, 30)}" action=enrich` +
            (Object.keys(patch).length ? ` patched=${Object.keys(patch).join(',')}` : ' no_changes') +
            ` ts=${new Date().toISOString()}`,
          );
          return { lead: updated };
        }

        // Different requirement or different source — create a new opportunity.
        this.logger.log(
          `[OPPORTUNITY_CREATED] phone=${storedPhone} src=${dto.source} req="${normNewReq.slice(0, 30)}" existing_leads=${rows.length} ts=${new Date().toISOString()}`,
        );
      }
    }

    // Normalize empty-string context to undefined so the DB stores NULL, not ''.
    if ((dto as any).context === '') (dto as any).context = undefined;

    // UTM-signal context resolution: if context is still missing but UTM/click-id fields are
    // present (e.g. a manually-created CRM lead from a tracked URL), infer from signals.
    if (!dto.context && (dto.source === LeadSource.DIRECT || dto.source === LeadSource.SHOPIFY)) {
      const rawPayload = (dto as any).raw_payload || {};
      const gclid     = (dto as any).gclid || rawPayload.gclid;
      const fbclid    = (dto as any).fbclid || rawPayload.fbclid;
      const utmSrc    = ((dto as any).utm_source || rawPayload.utm_source || '').toLowerCase();
      const utmMed    = ((dto as any).utm_medium || rawPayload.utm_medium || '').toLowerCase();
      if (gclid || utmSrc.includes('google')) {
        (dto as any).context = gclid || utmMed === 'cpc' || utmMed === 'ppc'
          ? contextToLabel(LeadContext.GOOGLE_ADS)
          : contextToLabel(LeadContext.GOOGLE_ORGANIC);
      } else if (fbclid || utmSrc.match(/meta|facebook|fb|instagram/)) {
        (dto as any).context = contextToLabel(LeadContext.META_LEAD_FORM);
      }
    }

    // Default context for manual (DIRECT) leads when not supplied by the client.
    if (!dto.context && dto.source === LeadSource.DIRECT) {
      (dto as any).context = contextToLabel(LeadContext.DIRECT_MANUAL);
    }

    let assignedTo = dto.assigned_to;
    if (!assignedTo) {
      if (storedPhone) {
        // Auto-assign to telecaller queue only when a mobile number is present.
        // No phone = telecaller cannot call the lead → skip round-robin, leave for manual assignment.
        assignedTo = await this.assignmentService.getNextAssignee(dto.source) ?? undefined;
        if (!assignedTo) {
          this.logger.warn(`No eligible telecaller found for source=${dto.source} — lead will be unassigned`);
        }
      } else {
        this.logger.log(
          `[Assignment] source=${dto.source} — no phone on lead, skipping auto-assign (manual follow-up required)`,
        );
      }
    }

    // Count OTHER active leads for this phone — used only for logging (returning customer detection).
    // isDuplicate is intentionally FALSE here: if we reached this line, the requirement-aware dedup
    // fell through, meaning this is a DIFFERENT requirement from any existing active lead.
    // Marking a new opportunity as DUPLICATE would exclude it from getQueue() and findAll()
    // (operational quality filter), making a valid opportunity invisible to telecallers.
    // True duplicates (same phone + same requirement + same source) are caught earlier and
    // handled by enriching the existing lead — they never reach this point.
    const dupCount = storedPhone
      ? await this.leadRepo.count({ where: { phone: storedPhone, is_active: true } })
      : 0;
    const isReturningCustomer = dupCount > 0; // informational only — NOT used for quality classification

    // Link to existing customer if phone is already registered.
    const linkedCustomerId = await this.findCustomerIdByPhone(storedPhone);

    const isDuplicate = false; // never a true duplicate — see comment on isReturningCustomer above
    const isPhoneValid = dto.is_phone_valid !== false; // default true unless explicitly false
    const { quality, score } = this.computeLeadQuality(
      storedPhone,
      dto.email,
      dto.product_interest,
      isPhoneValid,
      isDuplicate,
      dto.source,
    );

    // Auto-elevate priority for highest-trust sources if not explicitly set
    const highTrustSources = new Set([LeadSource.OLD_CUSTOMER, LeadSource.REFERRAL]);
    if (!dto.lead_priority && highTrustSources.has(dto.source)) {
      (dto as any).lead_priority = LeadPriority.HIGH;
    }

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
      duplicate_flag: isDuplicate,
      idempotency_key: idempotencyKey ?? undefined,
      contextHistory: dto.context ? [dto.context] : [],
      context_history: dto.context ?? undefined,
      customer_id: linkedCustomerId ?? undefined,
      whatsappMessageId: dto.whatsappMessageId,
      hasSerializedId: dto.hasSerializedId ?? false,
      lead_quality: quality,
      quality_score: score,
      workflow_state: WorkflowState.FIRST_CALL,
      workflow_state_entered_at: new Date(),
      next_action_due_at: computeNextActionDue(WorkflowState.FIRST_CALL, dto.source, null),
      call_attempt_count: 0,
      no_answer_count: 0,
      automation_manually_paused: false,
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

    const qualityTag = (quality === 'TRACKING_ONLY' || quality === 'JUNK')
      ? `[${quality}]`
      : '[CRM_LEAD_CREATED]';
    this.logger.log(
      `${qualityTag} lead=${saved.lead_ref ?? saved.id} src=${dto.source} quality=${quality} phone=${storedPhone ?? 'none'} assigned_to=${assignedTo ?? 'none'}` +
      (isReturningCustomer ? ' returning_customer=true' : '') +
      (this._whatsappDown ? ' wa_fallback=true' : '') +
      ` ts=${new Date().toISOString()}`,
    );
    this.logsService.log(
      LogAction.LEAD_CREATED,
      { leadId: saved.id, phone: storedPhone, source: dto.source, assigned_to: assignedTo ?? null, returning_customer: isReturningCustomer },
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

    // Generate permanent lead_ref — set once on creation, never changed.
    // LD-YYYY-NNNNNN for operational leads; TRK-YYYY-NNNNNN for tracking/analytics.
    // Uses independent PostgreSQL sequences — TRK counter never affects LD counter.
    const refYear = new Date(saved.created_at ?? Date.now()).getFullYear();
    const isTrkRef = !hasOperationalIdentity(saved);
    const seqName  = isTrkRef ? 'lead_ref_trk_seq' : 'lead_ref_ld_seq';
    const refPrefix = isTrkRef ? 'TRK' : 'LD';
    try {
      const [{ nextval }] = await this.ds.query(`SELECT nextval('${seqName}') AS nextval`);
      const lead_ref = `${refPrefix}-${refYear}-${String(nextval).padStart(6, '0')}`;
      await this.leadRepo.update(saved.id, { lead_ref });
      saved.lead_ref = lead_ref;
      this.logger.log(
        `[LEAD_REF_ASSIGNED] type=${refPrefix} leadId=${saved.id} lead_ref=${lead_ref} source=${saved.source} quality=${saved.lead_quality ?? 'null'} ts=${new Date().toISOString()}`,
      );
    } catch (e) {
      this.logger.error(
        `[LEAD_REF_FAILED] leadId=${saved.id} seq=${seqName}: ${(e as any)?.message}`,
      );
      // Lead still exists without ref — migration script backfills on next run
    }

    return { lead: saved, warning: isReturningCustomer ? 'returning_customer' : undefined };
  }

  // ── List / Detail ────────────────────────────────────────────────────────────

  async findAll(filters: any, user: any): Promise<Lead[]> {
    const q = this.leadRepo.createQueryBuilder('l');

    // includeInactive=true is used exclusively by the All Leads historical view.
    // It must never apply to operational views (Today Tasks, Available Leads).
    // Restricted to elevated roles — telecallers always see active leads only.
    const canSeeInactive = filters.includeInactive === 'true' && (CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role);
    if (!canSeeInactive) {
      q.where('l.is_active = true');
    }
    if (!(CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role)) {
      // Show leads explicitly assigned/created by this user, plus unowned leads
      // (assigned_to IS NULL AND created_by IS NULL) — these are system-generated
      // webhook/Shopify leads that haven't been assigned yet. They form an open pool
      // any telecaller can pick up; once assigned they disappear from others' views.
      q.andWhere(
        '(l.assigned_to = :uid OR l.created_by = :uid OR (l.assigned_to IS NULL AND l.created_by IS NULL))',
        { uid: user.id },
      );
    }

    // Manager review queue — surfaces all leads needing human intervention
    if (filters.filter === 'manager-review') {
      if (!(CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role)) throw new ForbiddenException('Manager review requires elevated access');
      q.andWhere(
        `(
          l.tags @> '["needs_manager_review"]'
          OR l.tags @> '["stale_lead"]'
          OR l.tags @> '["callback_abuse_risk"]'
          OR l.tags @> '["esc_final_warning"]'
          OR l.no_answer_count >= 5
          OR (l.next_action_due_at < NOW() - INTERVAL '72 hours' AND l.status NOT IN ('CONVERTED', 'LOST'))
        )`,
      );
      q.andWhere('l.status NOT IN (:...terminalStates)', { terminalStates: ['CONVERTED', 'LOST'] });
      q.orderBy('l.next_action_due_at', 'ASC');
      return q.getMany();
    }

    if (filters.status) q.andWhere('l.status = :status', { status: filters.status });
    if (filters.source) q.andWhere('l.source = :source', { source: filters.source });
    if (filters.assigned_to) q.andWhere('l.assigned_to = :at', { at: filters.assigned_to });
    if (filters.search) {
      q.andWhere('(l.name ILIKE :s OR l.phone ILIKE :s OR l.email ILIKE :s OR l.lead_ref ILIKE :s)', {
        s: `%${filters.search}%`,
      });
    }
    if (filters.from) q.andWhere('l.created_at >= :from', { from: filters.from });
    if (filters.to) q.andWhere('l.created_at <= :to', { to: filters.to });
    // Attribution filters — stored as text columns or JSONB on raw_payload
    if (filters.context) q.andWhere('l.context ILIKE :ctx', { ctx: `%${filters.context}%` });
    if (filters.utm_source) q.andWhere(`l.raw_payload->>'utm_source' ILIKE :utmSrc`, { utmSrc: `%${filters.utm_source}%` });
    if (filters.utm_campaign) q.andWhere(`l.raw_payload->>'utm_campaign' ILIKE :utmCmp`, { utmCmp: `%${filters.utm_campaign}%` });

    // Quality filter: exact tier when specified; operational-only excludes TRACKING_ONLY/JUNK/DUPLICATE.
    // NULL quality rows (pre-backfill) are treated as operational (included).
    if (filters.quality) {
      q.andWhere('l.lead_quality = :quality', { quality: filters.quality });
    } else if (filters.operationalOnly === 'true') {
      q.andWhere(
        '(l.lead_quality IS NULL OR l.lead_quality NOT IN (:...nonOp))',
        { nonOp: [...CRM_NON_OPERATIONAL_QUALITIES] },
      );
      // Identity gate: Available Leads (operational view) only shows contactable leads.
      q.andWhere('(l.phone IS NOT NULL OR l.email IS NOT NULL)');
    }

    q.orderBy('l.created_at', 'DESC');
    return q.getMany();
  }

  async findOne(
    id: number,
    user: any,
    ip?: string,
  ): Promise<Lead & { activityNotes: LeadNote[]; followups: LeadFollowUp[]; journey: any; lockInfo: any }> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Acquire 15-min view lock — warns other users that someone is actively working this lead
    this.acquireLock(id, user);
    const lockInfo = this.getLockInfo(id);
    void this.auditService.log(id, user.id, 'VIEWED', undefined, ip);

    const [notes, followups, quotationRows, orderRows, prevLeadRows, siblingOpportunities] = await Promise.all([
      this.noteRepo.find({ where: { lead_id: id }, order: { created_at: 'DESC' } }),
      this.followUpRepo.find({ where: { lead_id: id }, order: { due_date: 'ASC' } }),
      this.ds.query<any[]>(
        `SELECT id, quotation_no, status, total_amount, created_at FROM quotation WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
      this.ds.query<any[]>(
        `SELECT id, order_no, status, total_amount, created_at FROM orders WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
      lead.customer_id
        ? this.ds.query<any[]>(
            `SELECT id, lead_ref, status, stage, source, created_at FROM leads WHERE customer_id = $1 AND id != $2 AND is_active = true ORDER BY created_at DESC LIMIT 10`,
            [lead.customer_id, id],
          )
        : Promise.resolve([]),
      // Customer lifetime — all CRM opportunities for the same phone or email, regardless of active/inactive.
      // Groups same-phone requirements so telecallers see the full customer journey
      // across separate opportunities (e.g., "Microfiber Cloth" vs "Display Stand" from same customer).
      (lead.phone || lead.email)
        ? this.ds.query<any[]>(
            `SELECT id, lead_ref, status, workflow_state, source, product_interest,
                    created_at, last_outcome_type, call_attempt_count, is_active
             FROM leads
             WHERE id != $1
               AND (
                 ($2::varchar IS NOT NULL AND phone = $2)
                 OR ($3::varchar IS NOT NULL AND email = $3)
               )
             ORDER BY created_at DESC
             LIMIT 20`,
            [id, lead.phone ?? null, lead.email ?? null],
          )
        : Promise.resolve([]),
    ]);

    const totalRevenue = orderRows.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0);

    const journey = {
      quotations: quotationRows,
      orders: orderRows,
      totalRevenue,
      previousLeads: prevLeadRows,
      previousLeadsCount: prevLeadRows.length,
      // Requirement-separated opportunities from the same customer identity (phone/email).
      previousOpportunities: siblingOpportunities,
    };

    return { ...lead, activityNotes: notes, followups, journey, lockInfo };
  }

  // ── State observability ──────────────────────────────────────────────────────

  /** Emit a [STATE_CHANGE] log line at every status/workflow_state/stage mutation. */
  private logStateChange(
    field: 'status' | 'workflow_state' | 'stage',
    prev: string | null,
    next: string,
    lead: { id: number; lead_ref?: string | null },
    trigger: string,
    userId: number | string | null,
  ): void {
    this.logger.log(
      `[STATE_CHANGE] lead=${lead.lead_ref ?? lead.id} field=${field} prev=${prev ?? 'null'} next=${next} trigger=${trigger} userId=${userId ?? 'system'} ts=${new Date().toISOString()}`,
    );
  }

  /**
   * Detect and log logical inconsistencies between the three parallel state systems.
   * Observe-only — does NOT auto-fix. Called after any state mutation.
   */
  private detectStateDivergence(lead: Partial<Lead> & { id: number }, trigger: string): void {
    const status = lead.status as string | undefined;
    const wf     = lead.workflow_state as string | undefined;
    if (!status) return;

    const checks: Array<[boolean, string]> = [
      [['CONTACTED', 'INTERESTED', 'QUOTATION'].includes(status) && !wf,
        `status=${status} but workflow_state=null`],
      [status === 'CONVERTED' && !!wf && wf !== 'CONVERTED',
        `status=CONVERTED but workflow_state=${wf}`],
      [status === 'LOST' && !!wf && wf !== 'LOST',
        `status=LOST but workflow_state=${wf}`],
      [status === 'NEW' && (wf === 'CONVERTED' || wf === 'LOST'),
        `status=NEW but workflow_state=${wf}`],
    ];

    for (const [cond, detail] of checks) {
      if (cond) {
        this.logger.warn(
          `[STATE_DIVERGENCE] lead=${lead.lead_ref ?? lead.id} trigger=${trigger} detail="${detail}"`,
        );
      }
    }
  }

  // ── Workflow state mutation helper ──────────────────────────────────────────

  /**
   * Atomically writes workflow_state + both SLA timestamps in one SQL round-trip.
   * Validates the transition first — throws if invalid for non-bypass roles.
   * Called from update() for status-driven transitions; logAction() uses its own
   * atomic SQL block to avoid race conditions on counter increments.
   */
  private async transitionWorkflowState(
    lead: Lead,
    to: WorkflowState,
    user: any,
    ip?: string,
    callbackDate?: Date | null,
  ): Promise<{ nextDue: Date | null }> {
    const from = lead.workflow_state as WorkflowState | null;
    const isBypass = WORKFLOW_BYPASS_ROLES.includes(user?.role);
    if (!isValidWorkflowTransition(from, to, isBypass)) {
      throw new BadRequestException(`Invalid workflow transition: ${from ?? 'none'} → ${to}`);
    }
    const nextDue = computeNextActionDue(to, lead.source, callbackDate ?? lead.follow_up_date ?? null, new Date());
    await this.ds.query(
      `UPDATE leads SET workflow_state = $1, workflow_state_entered_at = NOW(), next_action_due_at = $3 WHERE id = $2`,
      [to, lead.id, nextDue],
    );
    this.logStateChange('workflow_state', from, to, lead, 'transitionWorkflowState', user?.id ?? null);
    void this.auditService.log(lead.id, user.id, 'UPDATED', `Workflow: ${from ?? 'none'} → ${to}`, ip);
    return { nextDue };
  }

  // ── Decision Engine endpoints ────────────────────────────────────────────────

  /** Deterministic operational queue — leads sorted by 6-tier SLA priority engine.
   *
   *  Tier 1  CALLBACK_WAIT  due within 30 min (promised callback imminent / overdue)
   *  Tier 2  SEND_QUOTATION                   (hot commercial intent, always beats generic overdue)
   *  Tier 3  SLA breach     any standard state where next_action_due_at < NOW()
   *  Tier 4  Escalation     NO_ANSWER_ESC or needs_manager_review tag
   *  Tier 5  Active         FIRST_CALL / FOLLOW_UP / CHASE_QUOTATION / NEGOTIATING within SLA
   *  Tier 6  Nurture        NURTURE re-engagement window open
   *  Tier 0  Excluded       CONVERTED, LOST, future CALLBACK_WAIT, future NURTURE
   *
   *  Single DB query + in-memory tier computation — no N+1 queries.
   *  Preserves existing item shape { lead, score, nextAction, isOverdue, ageHours }
   *  and enriches with { queueTier, overdueMins, slaStatus }. */
  async getQueue(user: any): Promise<any[]> {
    const q = this.leadRepo.createQueryBuilder('l');
    q.where('l.is_active = true');
    // CONVERTED and LOST are excluded from the operational queue.
    // LOST leads can be surfaced via explicit re-engagement filters in future.
    q.andWhere('l.status NOT IN (:...done)', { done: ['CONVERTED', 'LOST'] });

    if (!(CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role)) {
      q.andWhere('(l.assigned_to = :uid OR l.created_by = :uid)', { uid: user.id });
    }

    // Non-actionable quality tiers excluded — NULL quality rows treated as operational.
    q.andWhere(
      '(l.lead_quality IS NULL OR l.lead_quality NOT IN (:...nonOp))',
      { nonOp: [...CRM_NON_OPERATIONAL_QUALITIES] },
    );
    // Identity gate: Today Tasks must only include leads with at least one contact field.
    // Leads without phone AND email cannot be called or contacted — no queue slot needed.
    q.andWhere('(l.phone IS NOT NULL OR l.email IS NOT NULL)');

    // No DB ordering — tier engine produces the final sorted output
    const leads = await q.getMany();
    const now    = Date.now();
    const nowDate = new Date(now);

    const items = leads.map(lead => {
      const score     = this.decisionEngine.scoreLead(lead);
      const queueTier = computeQueueTier(lead, now);

      // For CALLBACK_WAIT: pass next_action_due_at as callbackPromisedAt so the
      // decision engine renders the correct countdown label in the queue card.
      // All other history fields read from entity — no follow-up repo query needed.
      const minHistory: OutcomeHistory = {
        callAttempts:      lead.call_attempt_count ?? 0,
        noAnswerCount:     lead.no_answer_count ?? 0,
        laterCount:        0,
        lastOutcomeType:   (lead.last_outcome_type as OutcomeHistory['lastOutcomeType']) ?? null,
        lastCallAt:        lead.last_contacted_at ?? null,
        lastObjectionType: lead.last_objection_type ?? null,
        callbackPromisedAt: lead.workflow_state === WorkflowState.CALLBACK_WAIT
          ? (lead.next_action_due_at ?? null)
          : null,
        workflowState: lead.workflow_state ?? null,
      };

      const nextAction  = this.decisionEngine.getNextAction(lead, minHistory);
      const ageHours    = Math.round((now - new Date(lead.created_at).getTime()) / 3_600_000);
      const dueMs       = lead.next_action_due_at ? new Date(lead.next_action_due_at).getTime() : null;
      const isOverdue   = dueMs !== null && dueMs < now;
      const overdueMins = dueMs !== null ? Math.round((now - dueMs) / 60_000) : 0;
      const slaStatus   = computeSlaStatus(lead.next_action_due_at, nowDate);

      const isBlocked = LeadService.isOperationallyBlocked(lead);
      return { lead, score, nextAction, isOverdue, ageHours, queueTier, overdueMins, slaStatus, isBlocked };
    });

    // Exclude tier-0 leads (future wait states, terminals — no action needed now)
    const operational = items.filter(i => i.queueTier > 0);

    const urgencyRank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

    operational.sort((a, b) => {
      // Primary: tier (1 = highest priority)
      if (a.queueTier !== b.queueTier) return a.queueTier - b.queueTier;

      // Secondary: tier-specific ordering
      const aDue = a.lead.next_action_due_at ? +new Date(a.lead.next_action_due_at) : 0;
      const bDue = b.lead.next_action_due_at ? +new Date(b.lead.next_action_due_at) : 0;

      switch (a.queueTier) {
        case 1: // CALLBACK_WAIT — soonest due / most recently overdue first (ASC)
          return aDue - bDue;

        case 2: // SEND_QUOTATION — oldest SLA first (most at risk of going cold)
          return aDue - bDue;

        case 3: // SLA BREACH — most overdue first (MAX overdueMins)
          return b.overdueMins - a.overdueMins;

        case 4: { // ESCALATION — highest no_answer_count, then score
          const naDiff = (b.lead.no_answer_count ?? 0) - (a.lead.no_answer_count ?? 0);
          return naDiff !== 0 ? naDiff : b.score - a.score;
        }

        case 5: { // ACTIVE PIPELINE — urgency → score → newest activity
          const ua = urgencyRank[a.nextAction?.urgency] ?? 1;
          const ub = urgencyRank[b.nextAction?.urgency] ?? 1;
          if (ua !== ub) return ua - ub;
          if (a.score !== b.score) return b.score - a.score;
          const actA = +(a.lead.last_contacted_at ?? a.lead.created_at);
          const actB = +(b.lead.last_contacted_at ?? b.lead.created_at);
          return actB - actA;
        }

        case 6: // NURTURE — most overdue first
          return b.overdueMins - a.overdueMins;

        default:
          return b.score - a.score;
      }
    });

    return operational;
  }

  /** Full decision context for a single lead.
   *  Reads structured workflow memory directly from the lead entity — no note queries. */
  async getDecision(id: number, user: any): Promise<DecisionContext> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Only fetch the next pending follow-up for callback countdown
    const pendingFu = await this.followUpRepo.findOne({
      where: { lead_id: id, is_completed: false },
      order: { due_date: 'ASC' },
    });

    const history: OutcomeHistory = {
      callAttempts:       lead.call_attempt_count ?? 0,
      noAnswerCount:      lead.no_answer_count ?? 0,
      laterCount:         0,  // not tracked separately; use workflowState instead
      lastOutcomeType:    (lead.last_outcome_type as OutcomeHistory['lastOutcomeType']) ?? null,
      lastCallAt:         lead.last_contacted_at ?? null,
      lastObjectionType:  lead.last_objection_type ?? null,
      callbackPromisedAt: pendingFu?.due_date ?? null,
      workflowState:      lead.workflow_state ?? null,
    };

    return this.decisionEngine.getDecisionContext(lead, history);
  }

  /** Log a call outcome note and optionally advance stage.
   *  When outcomeType is provided, atomically updates all workflow memory fields
   *  (workflow_state, last_outcome_type, counters, last_contacted_at) via SQL so
   *  no counter drift can occur from concurrent requests. */
  async logAction(
    id: number,
    body: {
      note: string;
      noteType?: NoteType;
      newStatus?: string;
      outcomeType?: OutcomeType;
      objectionType?: string;
      /** ISO datetime of promised callback — sent by frontend for LATER outcomes.
       *  Used to set next_action_due_at = exact promised time for CALLBACK_WAIT state. */
      callbackDate?: string;
    },
    user: any,
    ip?: string,
  ): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Lock enforcement: reject if another user holds an active view lock.
    // Uses workflow bypass roles (Admin/COO only) — Sales Manager cannot bypass locks.
    const isBypass = (CRM_WORKFLOW_BYPASS_ROLES as readonly string[]).includes(user?.role);
    if (!isBypass) {
      const lock = this.getLockInfo(id);
      if (lock && lock.userId !== user.id) {
        throw new ForbiddenException(`Lead is being worked by ${lock.userName}. Try again in a few minutes.`);
      }
    }

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
      this.eventEmitter.emit('crm.lead.action_logged', {
        lead_id:   id,
        lead_name: lead.name,
        user_id:   user?.id ?? null,
        user_name: user?.name ?? null,
      });
      // Auto-complete any pending AUTO follow-ups — workflow advances via call outcome,
      // not via manual "Done" clicks, so orphaned AUTO reminders should be cleared.
      await this.followUpRepo.update(
        { lead_id: id, is_completed: false, created_by: IsNull() as any },
        { is_completed: true, completed_at: new Date() },
      );

      // ── Atomic workflow memory mutation ────────────────────────────────────
      // All counter increments use SQL so concurrent calls don't race.
      if (body.outcomeType && !LeadService.hasIdentity(lead)) {
        throw new BadRequestException(
          'Cannot log a call outcome on a lead without a valid phone number or email address.',
        );
      }
      if (body.outcomeType) {
        const outcome = body.outcomeType;
        let newWorkflowState: WorkflowState;
        let resetNoAnswer = false;

        if (outcome === OutcomeType.INTERESTED) {
          newWorkflowState = WorkflowState.SEND_QUOTATION;
          resetNoAnswer = true;
        } else if (outcome === OutcomeType.LATER) {
          // CHASE_QUOTATION + LATER = customer is still in discussion — advance to NEGOTIATING
          newWorkflowState = lead.workflow_state === WorkflowState.CHASE_QUOTATION
            ? WorkflowState.NEGOTIATING
            : WorkflowState.CALLBACK_WAIT;
          resetNoAnswer = true;
        } else if (outcome === OutcomeType.NOT_INTERESTED) {
          newWorkflowState = WorkflowState.NURTURE;
        } else {
          // NO_ANSWER — state depends on the new count after increment
          // Computed in SQL CASE below (avoids read-then-write race)
          newWorkflowState = WorkflowState.NO_ANSWER_1; // placeholder; overridden in SQL
        }

        const now = new Date();
        const callbackDate = body.callbackDate ? new Date(body.callbackDate) : null;

        if (outcome === OutcomeType.NO_ANSWER) {
          // Increment no_answer_count and derive workflow_state + SLA timestamps atomically.
          // next_action_due_at mirrors computeNextActionDue() for each NO_ANSWER state.
          await this.ds.query(`
            UPDATE leads SET
              call_attempt_count        = COALESCE(call_attempt_count, 0) + 1,
              no_answer_count           = COALESCE(no_answer_count, 0) + 1,
              last_outcome_type         = $1,
              last_contacted_at         = NOW(),
              workflow_state_entered_at = NOW(),
              workflow_state            = CASE
                WHEN COALESCE(no_answer_count, 0) + 1 = 1 THEN 'NO_ANSWER_1'
                WHEN COALESCE(no_answer_count, 0) + 1 = 2 THEN 'NO_ANSWER_2'
                ELSE 'NO_ANSWER_ESC'
              END,
              next_action_due_at        = CASE
                WHEN COALESCE(no_answer_count, 0) + 1 = 1 THEN NOW() + INTERVAL '8 hours'
                WHEN COALESCE(no_answer_count, 0) + 1 = 2 THEN NOW() + INTERVAL '24 hours'
                ELSE NOW() + INTERVAL '48 hours'
              END
            WHERE id = $2
          `, [outcome, id]);

          const noAnswerNewCount = (lead.no_answer_count ?? 0) + 1;
          const noAnswerNewState = noAnswerNewCount === 1 ? WorkflowState.NO_ANSWER_1
            : noAnswerNewCount === 2 ? WorkflowState.NO_ANSWER_2
            : WorkflowState.NO_ANSWER_ESC;
          this.logStateChange('workflow_state', lead.workflow_state ?? null, noAnswerNewState, lead, 'call_outcome_NO_ANSWER', user?.id ?? null);

          // Circuit breaker: 5+ unanswered calls → tag + escalate to manager
          const newNoAnswerCount = noAnswerNewCount;
          if (newNoAnswerCount >= 5) {
            await this.ds.query(`
              UPDATE leads
              SET tags = CASE
                WHEN NOT (COALESCE(tags, '[]'::jsonb) ? 'needs_manager_review')
                  THEN COALESCE(tags, '[]'::jsonb) || '["needs_manager_review"]'::jsonb
                ELSE tags
              END
              WHERE id = $1
            `, [id]);
            this.eventEmitter.emit('crm.lead.escalated', {
              id,
              name:             lead.name,
              phone:            lead.phone ?? null,
              assigned_to:      lead.assigned_to ?? null,
              product_interest: lead.product_interest ?? null,
              reason:           `NO_ANSWER circuit breaker: ${newNoAnswerCount} unanswered calls`,
              no_answer_count:  newNoAnswerCount,
            });
          }
        } else {
          // All other outcomes — compute SLA deadline via single source of truth function
          const nextDue = computeNextActionDue(newWorkflowState, lead.source, callbackDate, now);
          await this.ds.query(`
            UPDATE leads SET
              call_attempt_count        = COALESCE(call_attempt_count, 0) + 1,
              no_answer_count           = COALESCE($1, no_answer_count),
              last_outcome_type         = $2,
              last_objection_type       = COALESCE($3, last_objection_type),
              last_contacted_at         = NOW(),
              workflow_state            = $4,
              workflow_state_entered_at = NOW(),
              next_action_due_at        = $6
            WHERE id = $5
          `, [
            resetNoAnswer ? 0 : null,
            outcome,
            body.objectionType ?? null,
            newWorkflowState,
            id,
            nextDue,
          ]);
          this.logStateChange('workflow_state', lead.workflow_state ?? null, newWorkflowState, lead, `call_outcome_${outcome}`, user?.id ?? null);
        }
      } else {
        // Unstructured CALL note (free-text, no outcomeType) — only increment attempt count
        await this.ds.query(`
          UPDATE leads SET
            call_attempt_count = COALESCE(call_attempt_count, 0) + 1,
            last_contacted_at  = NOW()
          WHERE id = $1
        `, [id]);

        // Warn in critical states where structured outcomes are required for pipeline accuracy
        const criticalStates = new Set<WorkflowState>([
          WorkflowState.CALLBACK_WAIT,
          WorkflowState.SEND_QUOTATION,
          WorkflowState.CHASE_QUOTATION,
          WorkflowState.NEGOTIATING,
        ]);
        if (lead.workflow_state && criticalStates.has(lead.workflow_state as WorkflowState)) {
          await this.noteRepo.save(
            this.noteRepo.create({
              lead_id: id,
              note:    `⚠️ Call logged without an outcome in ${lead.workflow_state} state. Select an outcome (Interested / Later / No Answer) to keep the pipeline accurate.`,
              type:    NoteType.SYSTEM,
              created_by: user.id,
            }),
          );
          void this.auditService.log(id, user.id, 'UPDATED', `Unstructured call in critical state: ${lead.workflow_state}`, ip);
        }
      }
    }

    if (noteType === NoteType.SYSTEM) {
      this.eventEmitter.emit('crm.lead.system_note', {
        lead_id: id,
        note: body.note,
        user_id: user?.id ?? null,
        user_name: user?.name ?? null,
      });
    }

    if (body.newStatus && body.newStatus !== lead.status) {
      return this.update(id, { status: body.newStatus as LeadStatus } as UpdateLeadDto, user, ip);
    }

    // Return the fresh lead so callers see the updated workflow state
    return (await this.leadRepo.findOne({ where: { id } }))!;
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

      this.logStateChange('status', prevStatus, saved.status, saved, 'manual_update', user?.id ?? null);
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

        // Sync workflow_state to match new status — status change always overrides
        // any outcome-derived state because a manual stage advance is intentional.
        const statusToWorkflowState: Partial<Record<LeadStatus, WorkflowState>> = {
          [LeadStatus.NEW]:        WorkflowState.FIRST_CALL,
          [LeadStatus.CONTACTED]:  WorkflowState.FOLLOW_UP,
          [LeadStatus.INTERESTED]: WorkflowState.SEND_QUOTATION,
          [LeadStatus.QUOTATION]:  WorkflowState.CHASE_QUOTATION,
          [LeadStatus.CONVERTED]:  WorkflowState.CONVERTED,
          [LeadStatus.LOST]:       WorkflowState.LOST,
        };
        const targetWfState = statusToWorkflowState[saved.status as LeadStatus];
        if (targetWfState) {
          // Regression protection: if the lead is already in a protected state
          // at a higher rank, skip the workflow_state update for non-bypass roles.
          // The status change is still persisted — only the workflow_state is guarded.
          const currentWfState = saved.workflow_state as WorkflowState | null;
          const currentRank    = currentWfState ? (WORKFLOW_RANK[currentWfState] ?? 0) : 0;
          const targetRank     = WORKFLOW_RANK[targetWfState] ?? 0;
          const isBypass       = WORKFLOW_BYPASS_ROLES.includes(user?.role);
          const isRegression   = !isBypass && currentWfState && PROTECTED_WORKFLOW_STATES.has(currentWfState) && targetRank < currentRank;

          // Identity gate: operational workflow states require phone or email.
          // Log + skip — the status save succeeds, but the no-identity lead stays
          // in its current workflow_state rather than advancing operationally.
          if (OPERATIONAL_WORKFLOW_STATES.has(targetWfState) && !LeadService.hasIdentity(saved)) {
            this.logger.warn(
              `[STATE_CHANGE] lead=${saved.lead_ref ?? id} field=workflow_state trigger=update_identity_blocked: no phone/email, keeping ${currentWfState ?? 'null'} instead of ${targetWfState}`,
            );
          } else if (isRegression) {
            this.logger.warn(
              `[STATE_CHANGE] lead=${saved.lead_ref ?? id} field=workflow_state trigger=update_regression_blocked: ${currentWfState}(rank ${currentRank}) → ${targetWfState}(rank ${targetRank}) blocked`,
            );
          } else {
            const nextDue = computeNextActionDue(targetWfState, saved.source, saved.follow_up_date, new Date());
            await this.ds.query(
              `UPDATE leads SET workflow_state = $1, workflow_state_entered_at = NOW(), next_action_due_at = $3 WHERE id = $2`,
              [targetWfState, id, nextDue],
            );
            this.logStateChange('workflow_state', currentWfState, targetWfState, saved, 'status_sync', user?.id ?? null);
            saved.workflow_state = targetWfState;
            saved.workflow_state_entered_at = new Date();
            saved.next_action_due_at = nextDue!;
          }
        }
        this.detectStateDivergence(saved, 'update');
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

    if (!(CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role)) {
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
    this.eventEmitter.emit('crm.lead.assigned', { id, name: lead.name, assigned_to: userId, assigned_to_name: target.name, assigned_by_id: user.id, assigned_by_name: user.name });
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
    this.eventEmitter.emit('crm.lead.note_added', { lead_id: leadId, lead_name: lead.name, by_user_id: user.id, by_user_name: user.name });
    return saved;
  }

  async getNotes(leadId: number, user: any): Promise<LeadNote[]> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    return this.noteRepo.find({ where: { lead_id: leadId }, order: { created_at: 'DESC' } });
  }

  private static isOperationallyBlocked(lead: Lead): boolean {
    return (lead.no_answer_count ?? 0) >= 5;
  }

  /**
   * @deprecated Use hasContactInfo() from crm.constants instead.
   * Kept for call sites not yet migrated.
   */
  static hasIdentity(lead: Lead): boolean {
    return hasContactInfo(lead);
  }

  async addFollowUp(leadId: number, body: { due_date: string; note?: string }, user: any, ip?: string): Promise<LeadFollowUp> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    // Write an audit signal when scheduling a callback on an operationally blocked lead
    if (LeadService.isOperationallyBlocked(lead)) {
      await this.noteRepo.save(
        this.noteRepo.create({
          lead_id: leadId,
          note: `⚠️ [NO ANSWER ESC] Scheduling callback on operationally blocked lead (${lead.no_answer_count} unanswered calls).`,
          type: NoteType.SYSTEM,
          created_by: user.id,
        }),
      );
    }

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
    this.eventEmitter.emit('crm.lead.followup.created', {
      lead_id:   leadId,
      lead_name: lead.name,
      due_date:  body.due_date,
      note:      body.note ?? null,
      user_id:   user?.id ?? null,
      user_name: user?.name ?? null,
    });
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
    this.eventEmitter.emit('crm.lead.followup.completed', { lead_id: fu.lead_id, followup_id: followUpId, by_user_id: user.id, by_user_name: user.name });
    this.eventEmitter.emit('lead.followup.completed', { followup_id: followUpId });
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

  /**
   * Customer Intelligence Match — phone-first, email-fallback.
   * Returns null when no existing customer is found.
   * All heavy queries run in parallel via Promise.all.
   * Called on-demand from LeadDetail/WorkMode only (NOT injected into queue responses).
   */
  async getCustomerMatch(id: number, user: any): Promise<Record<string, any> | null> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const em = this.leadRepo.manager;

    let customerId: number | null = null;
    let matchedBy: 'phone' | 'email' = 'phone';
    let matchTier: 'EXACT' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

    // 0. Shortcut: lead.customer_id already set at creation (fastest path)
    if (lead.customer_id) {
      customerId = lead.customer_id;
      matchTier = 'EXACT';
    }

    // 1. Phone match — generate all normalized formats so we hit regardless of how
    //    the phone was stored in leads (bare-10 "9884052555") vs customer_phones ("+919884052555").
    if (!customerId && lead.phone) {
      const digits = lead.phone.replace(/\D/g, '');
      const bare10 = digits.slice(-10);
      // Build de-duplicated set of all plausible stored formats
      const formats = [...new Set([
        lead.phone,          // stored as-is in leads
        bare10,              // bare 10-digit
        `+91${bare10}`,      // E.164 with +
        `91${bare10}`,       // E.164 without +
      ])].filter(Boolean);
      const ph = formats.map((_, i) => `$${i + 1}`).join(', ');

      // a. customer_phones index (indexed — fast)
      const cpRows = await em.query(
        `SELECT cp.customer_id FROM customer_phones cp WHERE cp.phone IN (${ph}) LIMIT 1`,
        formats,
      );
      if (cpRows.length) { customerId = Number(cpRows[0].customer_id); matchTier = 'EXACT'; }

      // b. Direct mobile1 fallback — covers customers created before the phone registry
      if (!customerId) {
        const c1Rows = await em.query(
          `SELECT id FROM customer WHERE mobile1 IN (${ph}) LIMIT 1`,
          formats,
        );
        if (c1Rows.length) { customerId = Number(c1Rows[0].id); matchTier = 'HIGH'; }
      }

      // c. Digit-normalized fallback — covers phones stored with spaces/dashes/country code
      //    Extracts last 10 digits from stored mobile1 and compares (no index, but LIMIT 1 is fast)
      //    Uses [^0-9] instead of \D — PostgreSQL POSIX regex doesn't support Perl shorthands
      if (!customerId) {
        const c2Rows = await em.query(
          `SELECT id FROM customer
           WHERE RIGHT(REGEXP_REPLACE(mobile1, '[^0-9]', '', 'g'), 10) = $1
             AND mobile1 IS NOT NULL
           LIMIT 1`,
          [bare10],
        );
        if (c2Rows.length) { customerId = Number(c2Rows[0].id); matchTier = 'HIGH'; }
      }
    }

    // 2. Email fallback — lowercase exact match only (no fuzzy, no partial)
    if (!customerId && lead.email) {
      matchedBy = 'email';
      const rows = await em.query(
        `SELECT id FROM customer WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [lead.email],
      );
      if (rows.length) { customerId = Number(rows[0].id); matchTier = 'HIGH'; }
    }

    if (!customerId) return null;

    // 3. Parallel intelligence queries — all touch indexed columns
    let customerRows: any[], ordersRows: any[], recentProductsRows: any[],
        financeRows: any[], ticketsRows: any[], amcRows: any[], pendingQuotesRows: any[],
        channelsRows: any[], salesmenRows: any[], ownershipRows: any[], recentLeadsRows: any[],
        conversionTimelineRows: any[], topObjectionRows: any[];
    try {
      [
        customerRows,
        ordersRows,
        recentProductsRows,
        financeRows,
        ticketsRows,
        amcRows,
        pendingQuotesRows,
        channelsRows,
        salesmenRows,
        ownershipRows,
        recentLeadsRows,
        conversionTimelineRows,
        topObjectionRows,
      ] = await Promise.all([
        em.query(
          `SELECT id, "companyName", "contactName", mobile1, email, city, "createdAt", "creditLimit" FROM customer WHERE id = $1`,
          [customerId],
        ),
        em.query(
          `SELECT COUNT(*)::int AS total,
                  MAX(created_at) AS last_order_date,
                  COALESCE(SUM(total_amount), 0)::numeric AS total_value,
                  MAX(order_no) AS last_order_no
           FROM orders WHERE customer_id = $1 AND status != 'CANCELLED'`,
          [customerId],
        ),
        em.query(
          `SELECT DISTINCT oi.item_name
           FROM order_item oi
           JOIN orders o ON o.id = oi."orderId"
           WHERE o.customer_id = $1
             AND o.created_at > NOW() - INTERVAL '1 year'
             AND oi.item_name IS NOT NULL
           ORDER BY oi.item_name LIMIT 5`,
          [customerId],
        ),
        em.query(
          `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric AS outstanding,
                  COALESCE(SUM(CASE WHEN status = 'OVERDUE' THEN outstanding_amount ELSE 0 END), 0)::numeric AS overdue
           FROM customer_receivables WHERE customer_id = $1 AND status != 'PAID'`,
          [customerId],
        ),
        em.query(
          `SELECT COUNT(*)::int AS open_tickets
           FROM service_tickets WHERE customer_id = $1 AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')`,
          [customerId],
        ),
        em.query(
          `SELECT COUNT(*)::int AS active_amc FROM amc_contracts WHERE customer_id = $1 AND status = 'ACTIVE'`,
          [customerId],
        ),
        em.query(
          `SELECT COUNT(*)::int AS pending FROM quotation WHERE customer_id = $1 AND status IN ('DRAFT','GENERATED')`,
          [customerId],
        ),
        // distinct lead sources → channels array
        em.query(
          `SELECT DISTINCT source FROM leads WHERE customer_id = $1 AND source IS NOT NULL`,
          [customerId],
        ),
        // all salesmen who touched this customer across leads / quotations / orders
        em.query(
          `SELECT DISTINCT u.id, u.name, u.role
           FROM (
             SELECT assigned_to AS uid FROM leads WHERE customer_id = $1 AND assigned_to IS NOT NULL
             UNION
             SELECT salesman_id FROM quotation WHERE customer_id = $1 AND salesman_id IS NOT NULL
             UNION
             SELECT salesman_id FROM orders WHERE customer_id = $1 AND salesman_id IS NOT NULL
           ) t
           JOIN "user" u ON u.id = t.uid`,
          [customerId],
        ),
        // latest revenue-generating interaction for ownership risk calculation
        em.query(
          `SELECT salesman_id, salesman_name, source_type, event_date FROM (
             SELECT o.salesman_id, u.name AS salesman_name, 'ORDER' AS source_type, o.created_at AS event_date
             FROM orders o
             LEFT JOIN "user" u ON u.id = o.salesman_id
             WHERE o.customer_id = $1 AND o.salesman_id IS NOT NULL AND o.status != 'CANCELLED'
             UNION ALL
             SELECT q.salesman_id, u.name AS salesman_name, 'QUOTATION' AS source_type, q.created_at AS event_date
             FROM quotation q
             LEFT JOIN "user" u ON u.id = q.salesman_id
             WHERE q.customer_id = $1 AND q.salesman_id IS NOT NULL
           ) combined
           ORDER BY event_date DESC LIMIT 1`,
          [customerId],
        ),
        // recent leads linked to this customer (for context panel)
        em.query(
          `SELECT id, status, stage, source, created_at FROM leads
           WHERE customer_id = $1 AND is_active = true
           ORDER BY created_at DESC LIMIT 5`,
          [customerId],
        ),
        // conversion timeline intelligence
        em.query(
          `SELECT
             COUNT(*) AS total_leads,
             COUNT(*) FILTER (WHERE status = 'CONVERTED') AS converted_leads,
             ROUND(AVG(
               EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0
             ) FILTER (WHERE status = 'CONVERTED')::numeric, 1) AS avg_sales_cycle_days,
             ROUND(EXTRACT(EPOCH FROM (
               MAX(updated_at) FILTER (WHERE status = 'CONVERTED')
               - MIN(created_at) FILTER (WHERE status = 'CONVERTED')
             )) / 86400.0, 1) AS last_cycle_span_days
           FROM leads
           WHERE customer_id = $1 AND is_active = true`,
          [customerId],
        ),
        // most common objection this customer gave
        em.query(
          `SELECT last_objection_type, COUNT(*) AS cnt
           FROM leads
           WHERE customer_id = $1 AND last_objection_type IS NOT NULL AND is_active = true
           GROUP BY last_objection_type
           ORDER BY cnt DESC LIMIT 1`,
          [customerId],
        ),
      ]);
    } catch (e) {
      console.error('[CUSTOMER MATCH ERROR] intelligence query failed for customerId', customerId, e);
      throw e;
    }

    if (!customerRows.length) return null;
    const c = customerRows[0];

    const totalOrders      = Number(ordersRows[0]?.total    ?? 0);
    const totalValue       = Number(ordersRows[0]?.total_value ?? 0);
    const outstanding      = Number(financeRows[0]?.outstanding ?? 0);
    const overdue          = Number(financeRows[0]?.overdue ?? 0);
    const openTickets      = Number(ticketsRows[0]?.open_tickets ?? 0);
    const activeAmc        = Number(amcRows[0]?.active_amc ?? 0);
    const pendingQuotations = Number(pendingQuotesRows[0]?.pending ?? 0);
    const lastOrderDate: string | null = ordersRows[0]?.last_order_date ?? null;
    const daysSinceLastOrder = lastOrderDate
      ? Math.floor((Date.now() - new Date(lastOrderDate).getTime()) / 86_400_000)
      : null;

    // Relationship flags — computed from live business data, no separate tables
    const flags: string[] = [];
    if (totalOrders >= 1)                                            flags.push('REPEAT_CUSTOMER');
    if (totalValue >= 100_000)                                       flags.push('HIGH_VALUE');
    if (overdue > 0)                                                 flags.push('PAYMENT_OVERDUE');
    if (activeAmc > 0)                                               flags.push('AMC_ACTIVE');
    if (openTickets > 0)                                             flags.push('SERVICE_RISK');
    if (daysSinceLastOrder !== null && daysSinceLastOrder > 180)     flags.push('INACTIVE_CUSTOMER');
    if (totalOrders >= 4)                                            flags.push('FREQUENT_BUYER');

    // Identity confidence — how certain we are this is the right customer
    const identity_confidence = matchTier;

    // Channels — lead sources that brought this customer in
    const channels: string[] = channelsRows.map((r: any) => r.source as string);

    // Salesmen who've handled this customer
    const salesmen = salesmenRows.map((r: any) => ({ id: Number(r.id), name: r.name, role: r.role }));

    // Ownership risk — compare the lead's current assignee vs the last revenue-generating salesman
    const ownershipRow = ownershipRows[0] ?? null;
    let ownershipRisk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';
    let ownershipWarning: string | null = null;
    if (ownershipRow) {
      const daysSinceOwnership = ownershipRow.event_date
        ? Math.floor((Date.now() - new Date(ownershipRow.event_date).getTime()) / 86_400_000)
        : null;
      const sameOwner = lead.assigned_to && Number(lead.assigned_to) === Number(ownershipRow.salesman_id);
      if (!sameOwner) {
        if (daysSinceOwnership !== null && daysSinceOwnership <= 30) {
          ownershipRisk = 'HIGH';
          ownershipWarning = `Last ${ownershipRow.source_type.toLowerCase()} was handled by ${ownershipRow.salesman_name} ${daysSinceOwnership}d ago — confirm before proceeding.`;
        } else if (daysSinceOwnership !== null && daysSinceOwnership <= 90) {
          ownershipRisk = 'MEDIUM';
          ownershipWarning = `Previously engaged by ${ownershipRow.salesman_name} — check with them before converting.`;
        } else {
          ownershipRisk = 'LOW';
          ownershipWarning = `Previous salesman: ${ownershipRow.salesman_name}.`;
        }
      }
    }

    // Customer health score — weighted penalty model
    let healthScore = 100;
    if (overdue > 0)                                                        healthScore -= 30;
    if (openTickets > 0)                                                    healthScore -= 20;
    if (daysSinceLastOrder !== null && daysSinceLastOrder > 180)            healthScore -= 25;
    if (pendingQuotations === 0 && totalOrders === 0)                       healthScore -= 15;
    const healthGrade =
      healthScore >= 80 ? 'EXCELLENT' :
      healthScore >= 60 ? 'GOOD' :
      healthScore >= 40 ? 'RISK' : 'CRITICAL';

    return {
      matched: true,
      matchedBy,
      identity_confidence,
      customer: {
        id: customerId,
        companyName: c.companyName,
        contactName: c.contactName,
        mobile1: c.mobile1,
        email: c.email,
        city: c.city,
        createdAt: c.createdAt,
        creditLimit: Number(c.creditLimit ?? 0),
      },
      commercial: {
        totalOrders,
        totalValue,
        lastOrderDate,
        lastOrderNo: ordersRows[0]?.last_order_no ?? null,
        pendingQuotations,
        recentProducts: recentProductsRows.map((r: any) => r.item_name as string),
      },
      finance: {
        outstanding,
        overdue,
        paymentDiscipline: overdue === 0 ? 'GOOD'
          : overdue / Math.max(outstanding, 1) > 0.5 ? 'POOR'
          : 'FAIR',
      },
      service: {
        openTickets,
        activeAmc,
        daysSinceLastOrder,
      },
      flags,
      channels,
      salesmen,
      ownership: {
        salesman_id: ownershipRow?.salesman_id ?? null,
        userName: ownershipRow?.salesman_name ?? null,
        sourceType: ownershipRow?.source_type ?? null,
        daysAgo: ownershipRow?.event_date
          ? Math.floor((Date.now() - new Date(ownershipRow.event_date).getTime()) / 86_400_000)
          : null,
        risk: ownershipRisk,
        warning: ownershipWarning,
      },
      health: {
        score: healthScore,
        grade: healthGrade,
      },
      recentLeads: recentLeadsRows.map((r: any) => ({
        id: r.id,
        status: r.status,
        stage: r.stage,
        source: r.source,
        createdAt: r.created_at,
      })),
      conversionTimeline: (() => {
        const t = conversionTimelineRows[0] ?? {};
        return {
          totalLeads:         +t.total_leads || 0,
          convertedLeads:     +t.converted_leads || 0,
          avgSalesCycleDays:  t.avg_sales_cycle_days !== null ? +t.avg_sales_cycle_days : null,
          lastCycleSpanDays:  t.last_cycle_span_days !== null ? +t.last_cycle_span_days : null,
          repeatLeadFrequency: +t.total_leads > 1 ? +t.total_leads : 0,
          mostCommonObjection: topObjectionRows[0]?.last_objection_type ?? null,
        };
      })(),
    };
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
      this.logStateChange('stage', currentStage, LeadStage.LOST, saved, 'updateStage', user?.id ?? null);
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
      this.logStateChange(
        'stage', prev, saved.stage, saved,
        i < targetIdx ? 'updateStage_auto_step' : 'updateStage',
        user?.id ?? null,
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
    // UTM attribution
    utm_source?: string; utm_medium?: string; utm_campaign?: string;
    utm_term?: string; utm_content?: string; gclid?: string; fbclid?: string;
  }): Promise<{ ok: boolean; leadId?: number; error?: string }> {
    const externalId = generateShopifyExternalId(payload);

    const rawName    = (payload.name || '').trim();
    const rawEmail   = normalizeIdentityField(payload.email) ?? '';
    const rawCity    = (payload.city || '').trim();
    const rawCountry = (payload.country || '').trim();
    const rawContext = (payload.context || '').trim();

    // Validate phone: reject empty, too-short, and all-same-digit fakes (0000000000, 9999999999…)
    const phoneIsReal     = isShopifyPhoneReal(payload.phone ?? '');
    const normalizedPhone = phoneIsReal ? normalizePhone(payload.phone ?? '') : 'unknown';
    const resolvedPhone   = phoneIsReal && normalizedPhone !== 'unknown' ? normalizedPhone : undefined;

    const resolvedContext = resolveShopifyUtmContext(rawContext, payload);

    const leadData: CreateLeadDto = {
      name:              rawName    || undefined,
      phone:             resolvedPhone,
      is_phone_valid:    phoneIsReal,
      email:             rawEmail   || undefined,
      city:              rawCity    || undefined,
      country:           rawCountry || undefined,
      context:           resolvedContext,
      product_interest:  payload.product || payload.product_title || payload.page_url || 'General Inquiry',
      notes:             payload.message ? payload.message : `Lead from ${payload.page_url || ''}`,
      source:            LeadSource.SHOPIFY,
      lead_source_label: resolvedContext,
      landing_page:      payload.page_url || '',
      external_id:       externalId,
      raw_payload:       {
        ...payload,
        last_message:    payload.message || '',
        last_message_at: new Date().toISOString(),
      },
    };

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
      const created = await this.create(leadData, { id: null, role: 'Admin' });
      if (created.analyticsOnly || !created.lead) {
        return { ok: true };
      }
      const lead = created.lead;
      this.logger.log(`Shopify lead id=${lead.id} external_id=${externalId}`);
      if (!phoneIsReal) {
        try {
          await this.addNote(lead.id, { note: 'Phone not provided from Shopify', type: NoteType.SYSTEM }, { id: null, role: 'Admin' });
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

      try {
        const created = await this.create(dto, { id: null, role: 'Admin' });
        if (created.analyticsOnly || !created.lead) {
          this.logger.log({
            action: 'WHATSAPP_LEAD_BLOCKED',
            reason: created.reason ?? 'no_identity',
            messageId: messageId ?? null,
          });
          return;
        }
        const savedLead = created.lead;

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

  /**
   * Compute quality tier and score for a new lead before saving.
   *
   * Scoring principles:
   * - DUPLICATE / AUTO_CAPTURED always win regardless of source
   * - Phone + email → QUALIFIED (any source)
   * - Phone only → PARTIAL; manual sources get a trust boost
   * - Email only → PARTIAL; manual sources get a trust boost
   * - No contact info:
   *     Manual/high-trust source → PARTIAL (physical context = some trust)
   *     Digital tracking source  → TRACKING_ONLY or JUNK
   */
  private computeLeadQuality(
    phone: string | null,
    email: string | undefined,
    productInterest: string | undefined,
    isPhoneValid: boolean,
    isDuplicate: boolean,
    source?: LeadSource,
  ): { quality: LeadQuality; score: number } {
    if (isDuplicate)         return { quality: LeadQuality.DUPLICATE,    score: 20 };
    if (!isPhoneValid && phone) return { quality: LeadQuality.AUTO_CAPTURED, score: 15 };

    const isManual     = source ? MANUAL_TRUST_SOURCES.has(source) : false;
    const isOldCust    = source === LeadSource.OLD_CUSTOMER;
    const isReferral   = source === LeadSource.REFERRAL;
    const hasProduct   = !!productInterest;

    // Both phone + email → QUALIFIED (trust boost for old customer / referral)
    if (phone && email) {
      const boost = isOldCust ? 10 : isReferral ? 5 : 0;
      return { quality: LeadQuality.QUALIFIED, score: Math.min(100, 85 + boost) };
    }

    // Phone only → PARTIAL with source-aware score
    if (phone) {
      let score = hasProduct ? 65 : 60;
      if (isOldCust || isReferral) score += 10;
      else if (isManual)           score += 5;
      return { quality: LeadQuality.PARTIAL, score: Math.min(100, score) };
    }

    // Email only → PARTIAL with source-aware score
    if (email) {
      let score = hasProduct ? 45 : 40;
      if (isManual) score += 10;
      return { quality: LeadQuality.PARTIAL, score: Math.min(100, score) };
    }

    // No contact info at all
    // Manual sources: physical/relationship context → PARTIAL (requires manual follow-up)
    if (isManual) {
      return { quality: LeadQuality.PARTIAL, score: hasProduct ? 25 : 20 };
    }
    // Digital tracking sources: TRACKING_ONLY or JUNK
    if (hasProduct) return { quality: LeadQuality.TRACKING_ONLY, score: 10 };
    return             { quality: LeadQuality.JUNK,           score: 5 };
  }

  /**
   * One-time cleanup (called from onModuleInit): deactivate leads that entered
   * operational workflow states without a valid phone or email.
   * Tags with 'archived_invalid_identity', clears workflow_state and next_action_due_at.
   * Never deletes data — purely sets is_active = false.
   */
  async archiveOperationalLeadsWithNoIdentity(): Promise<number> {
    const rows: { id: number }[] = await this.ds.query(`
      UPDATE leads SET
        is_active             = false,
        workflow_state        = NULL,
        next_action_due_at    = NULL,
        tags = CASE
          WHEN COALESCE(tags, '[]'::jsonb) ? 'archived_invalid_identity' THEN tags
          ELSE COALESCE(tags, '[]'::jsonb) || '["archived_invalid_identity"]'::jsonb
        END,
        notes = CASE
          WHEN notes IS NULL OR notes = ''
            THEN '[System] Archived: operational workflow state reached without valid contact identity.'
          WHEN notes NOT LIKE '%archived_invalid_identity%'
            THEN notes || E'\\n[System] Archived: operational workflow state reached without valid contact identity.'
          ELSE notes
        END,
        updated_at = NOW()
      WHERE is_active = true
        AND (phone IS NULL OR TRIM(phone) = '' OR LOWER(TRIM(phone)) = 'unknown')
        AND (email IS NULL OR TRIM(email) = '')
        AND workflow_state IS NOT NULL
        AND workflow_state NOT IN ('CONVERTED', 'LOST', 'NURTURE')
      RETURNING id
    `);
    const count = rows?.length ?? 0;
    if (count > 0) {
      this.logger.warn(
        `[LeadService] archiveOperationalLeadsWithNoIdentity: deactivated ${count} lead(s) — no phone/email in operational state`,
      );
    }
    return count;
  }

  /**
   * Mark active TRACKING_ONLY leads with no phone/email as operationally inactive.
   * Uses existing is_active + tags only — no schema changes.
   */
  async archiveOrphanTrackingLeads(): Promise<number> {
    const rows: { id: number }[] = await this.ds.query(`
      UPDATE leads
      SET
        is_active = false,
        tags = CASE
          WHEN COALESCE(tags, '[]'::jsonb) ? 'archived_tracking_only' THEN tags
          ELSE COALESCE(tags, '[]'::jsonb) || '["archived_tracking_only"]'::jsonb
        END,
        notes = CASE
          WHEN notes IS NULL OR notes = '' THEN '[System] Archived: tracking-only record without contact identity.'
          WHEN notes NOT LIKE '%Archived: tracking-only%' THEN notes || E'\\n[System] Archived: tracking-only record without contact identity.'
          ELSE notes
        END,
        updated_at = NOW()
      WHERE is_active = true
        AND lead_quality = 'TRACKING_ONLY'
        AND (phone IS NULL OR TRIM(phone) = '' OR LOWER(TRIM(phone)) = 'unknown')
        AND (email IS NULL OR TRIM(email) = '')
      RETURNING id
    `);
    const count = rows?.length ?? 0;
    if (count > 0) {
      this.logger.log(`[LeadService] archiveOrphanTrackingLeads: deactivated ${count} row(s)`);
    }
    return count;
  }

  private applyIdentityNormalization(dto: CreateLeadDto): {
    phone: string | null;
    email: string | null;
  } {
    const rawPhone = dto.phone;
    const rawEmail = dto.email;
    const phone = normalizePhoneForIdentity(rawPhone);
    const email = normalizeIdentityField(rawEmail)?.toLowerCase() ?? null;

    const phoneSentinelCleared =
      rawPhone != null &&
      String(rawPhone).trim() !== '' &&
      phone === null;
    const emailSentinelCleared =
      rawEmail != null &&
      String(rawEmail).trim() !== '' &&
      email === null;

    if (phoneSentinelCleared || emailSentinelCleared) {
      this.logger.log(
        `[IDENTITY_NORMALIZED] source=${dto.source} phone_cleared=${phoneSentinelCleared} email_cleared=${emailSentinelCleared}`,
      );
    }

    return { phone, email };
  }

  private async storeAsAnalyticsEventFromDto(dto: CreateLeadDto, reason: string): Promise<void> {
    await this.storeAsAnalyticsEvent({
      action: dto.lead_source_label ?? dto.context ?? dto.source,
      event: 'lead_blocked',
      product: dto.product_interest,
      page_url: dto.landing_page ?? '',
      source: dto.source,
      reason,
      raw_payload: dto.raw_payload ?? dto,
    });
  }

  /** Store an anonymous Shopify event in analytics_events without creating a CRM lead. */
  private async storeAsAnalyticsEvent(payload: Record<string, any>): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO analytics_events (session_id, event, product, page_url, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [
          `anon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          payload.action || payload.event || 'shopify_click',
          payload.product || payload.product_title || null,
          payload.page_url || '',
        ],
      );
    } catch (e: any) {
      this.logger.warn(`storeAsAnalyticsEvent failed: ${e?.message}`);
    }
  }

  private assertAccess(lead: Lead, user: any) {
    if ((CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role)) return;
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

  async getAuditLog(id: number, user: any): Promise<any[]> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    return this.ds.query(
      `SELECT a.id, a.action, a.detail, a.ip_address, a.created_at,
              u.name AS user_name, a.user_id
       FROM lead_audit_logs a
       LEFT JOIN "user" u ON u.id = a.user_id
       WHERE a.lead_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [id],
    );
  }

  async setAutomationPaused(
    id: number,
    paused: boolean,
    reason?: string,
    user?: any,
    ip?: string,
  ): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    if (paused) {
      if (!tags.includes('automation_off')) lead.tags = [...tags, 'automation_off'];
    } else {
      lead.tags = tags.filter(t => t !== 'automation_off');
    }
    // Track whether this is a deliberate manager pause (vs a temporary snooze).
    // resumeExpiredSnoozes() only auto-clears automation_off when this is false.
    lead.automation_manually_paused = paused;
    // Always clear snooze state when manually pausing or resuming
    lead.automation_snooze_until = null;
    lead.automation_snooze_reason = null;
    const saved = await this.leadRepo.save(lead);

    // Audit trail
    if (user?.id) {
      const action = paused ? 'paused' : 'resumed';
      const reasonSuffix = reason?.trim() ? ` Reason: ${reason.trim()}.` : '';
      await this.noteRepo.save(
        this.noteRepo.create({
          lead_id: id,
          note: `Automation ${action}.${reasonSuffix}`,
          type: NoteType.SYSTEM,
          created_by: user.id,
        }),
      );
      void this.auditService.log(id, user.id, 'UPDATED', `Automation ${action}${reasonSuffix}`, ip);
      this.eventEmitter.emit('crm.lead.automation.toggled', {
        lead_id:   id,
        action:    paused ? 'PAUSED' : 'RESUMED',
        reason:    reason?.trim() || null,
        user_id:   user.id,
        user_name: user.name ?? null,
      });
    }
    return saved;
  }

  async snoozeAutomation(
    id: number,
    durationMins: number,
    reason: string,
    user: any,
    ip?: string,
  ): Promise<Lead> {
    if (!reason?.trim()) throw new BadRequestException('Reason is required to snooze automation');
    if (!durationMins || durationMins <= 0) throw new BadRequestException('Duration must be a positive number of minutes');
    if (durationMins > 10_080) throw new BadRequestException('Automation snooze cannot exceed 7 days (10,080 minutes)');

    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    if (!tags.includes('automation_off')) lead.tags = [...tags, 'automation_off'];

    const snoozeUntil = new Date(Date.now() + durationMins * 60 * 1000);
    lead.automation_snooze_until = snoozeUntil;
    lead.automation_snooze_reason = reason.trim();
    // A snooze is temporary — it must NOT override a manager's deliberate manual pause flag.
    // Only set to false here; setAutomationPaused sets it to true when manager acts.
    lead.automation_manually_paused = false;

    // Snooze / callback abuse detection
    const snoozeCountRows: Array<{ count: string }> = await this.ds.query(`
      SELECT COUNT(*) AS count
      FROM lead_audit_logs
      WHERE lead_id = $1
        AND action = 'UPDATED'
        AND detail LIKE 'Automation snoozed%'
        AND created_at > NOW() - INTERVAL '30 days'
    `, [id]);
    const recentSnoozeCount = parseInt(snoozeCountRows[0]?.count ?? '0', 10);
    const currentTags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    const hasAbuseTag = currentTags.includes('callback_abuse_risk');

    // Block further snoozing when abuse threshold is reached and tag is already set
    if (hasAbuseTag && recentSnoozeCount >= 3) {
      await this.noteRepo.save(
        this.noteRepo.create({
          lead_id: id,
          note: `[CALLBACK MOVED] Snooze blocked — callback pushed ${recentSnoozeCount + 1} times in 30 days.`,
          type: NoteType.SYSTEM,
          created_by: user.id,
        }),
      );
      void this.auditService.log(id, user.id, 'UPDATED', `[CALLBACK MOVED] snooze blocked (${recentSnoozeCount + 1} attempts)`, ip);
      return lead; // abort without saving the snooze
    }

    // Tag callback abuse risk at 2+ snoozes (proxy for consecutive LATER outcomes)
    if (recentSnoozeCount >= 2 && !hasAbuseTag) {
      lead.tags = [...currentTags, 'callback_abuse_risk'];
      await this.noteRepo.save(
        this.noteRepo.create({
          lead_id: id,
          note: `[CALLBACK MOVED] Callback pushed ${recentSnoozeCount + 1} times — flagged for manager review.`,
          type: NoteType.SYSTEM,
          created_by: user.id,
        }),
      );
    }

    // Escalate to manager at 3+ snoozes
    if (recentSnoozeCount >= 3) {
      this.eventEmitter.emit('crm.lead.escalated', {
        id,
        name:             lead.name,
        phone:            lead.phone ?? null,
        assigned_to:      lead.assigned_to ?? null,
        product_interest: lead.product_interest ?? null,
        reason:           `Callback abuse: ${recentSnoozeCount + 1} automation snoozes in the last 30 days`,
        no_answer_count:  lead.no_answer_count ?? 0,
      });
    }

    const saved = await this.leadRepo.save(lead);

    // Audit trail
    const snoozeUntilStr = snoozeUntil.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    await this.noteRepo.save(
      this.noteRepo.create({
        lead_id: id,
        note: `Automation snoozed until ${snoozeUntilStr}. Reason: ${reason.trim()}.`,
        type: NoteType.SYSTEM,
        created_by: user.id,
      }),
    );
    void this.auditService.log(id, user.id, 'UPDATED', `Automation snoozed ${durationMins}min: ${reason.trim()}`, ip);
    this.eventEmitter.emit('crm.lead.automation.toggled', {
      lead_id:      id,
      action:       'SNOOZED',
      reason:       reason.trim(),
      snooze_until: snoozeUntilStr,
      user_id:      user.id,
      user_name:    user.name ?? null,
    });
    return saved;
  }
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

/**
 * Fine-grained operational state of a lead.
 * Drives next script, urgency, SLA, and queue priority.
 * Only mutated by logAction() (outcome-driven) and update() (status-driven).
 */
export enum WorkflowState {
  FIRST_CALL = 'FIRST_CALL', // New lead, no calls made yet
  FOLLOW_UP = 'FOLLOW_UP', // Contacted positively, standard follow-up
  NO_ANSWER_1 = 'NO_ANSWER_1', // 1 no-answer, retry at different time
  NO_ANSWER_2 = 'NO_ANSWER_2', // 2 no-answers, try different slot + WA
  NO_ANSWER_ESC = 'NO_ANSWER_ESC', // 3+ no-answers, escalate to manager
  CALLBACK_WAIT = 'CALLBACK_WAIT', // Customer requested callback at specific time
  SEND_QUOTATION = 'SEND_QUOTATION', // Interested — create and send quotation now
  CHASE_QUOTATION = 'CHASE_QUOTATION', // Quotation sent, follow up on decision
  NEGOTIATING = 'NEGOTIATING', // Post-quotation price/term discussion
  NURTURE = 'NURTURE', // Not interested now, re-engage scheduled
  CONVERTED = 'CONVERTED', // Deal closed
  LOST = 'LOST', // Permanently closed
}

export enum OutcomeType {
  INTERESTED = 'INTERESTED',
  NO_ANSWER = 'NO_ANSWER',
  LATER = 'LATER',
  NOT_INTERESTED = 'NOT_INTERESTED',
}

export enum LeadQuality {
  QUALIFIED = 'QUALIFIED', // has phone + email
  PARTIAL = 'PARTIAL', // has phone OR email (not both)
  TRACKING_ONLY = 'TRACKING_ONLY', // no contact info but has product interest
  DUPLICATE = 'DUPLICATE', // phone matched an existing lead
  JUNK = 'JUNK', // no phone, no email, no product interest
  AUTO_CAPTURED = 'AUTO_CAPTURED', // is_phone_valid=false (bot/fake number)
}

export enum LeadSource {
  // Digital / inbound (auto-captured)
  SHOPIFY = 'SHOPIFY',
  META = 'META',
  GOOGLE = 'GOOGLE',
  INDIAMART = 'INDIAMART',
  LINKEDIN = 'LINKEDIN',
  WHATSAPP = 'WHATSAPP',
  DIRECT = 'DIRECT',
  // High-trust manual sources (phone optional — physical context)
  WALK_IN = 'WALK_IN',
  REFERRAL = 'REFERRAL',
  EXHIBITION = 'EXHIBITION',
  FIELD_VISIT = 'FIELD_VISIT',
  OLD_CUSTOMER = 'OLD_CUSTOMER',
  DEALER_REFERENCE = 'DEALER_REFERENCE',
  BUSINESS_CARD = 'BUSINESS_CARD',
  IMPORTED = 'IMPORTED',
}

export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  INTERESTED = 'INTERESTED',
  QUOTATION = 'QUOTATION',
  CONVERTED = 'CONVERTED',
  LOST = 'LOST',
}

export enum LeadPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum LeadChannel {
  WHATSAPP = 'WHATSAPP',
  CALL = 'CALL',
  FORM = 'FORM',
}

export enum LeadStage {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  QUOTED = 'QUOTED',
  WON = 'WON',
  LOST = 'LOST',
}

@Index(['phone'])
@Index(['status'])
@Index(['source'])
@Index(['assigned_to'])
@Index(['created_at'])
@Index(['is_active', 'assigned_to', 'created_at'])
@Index(['idempotency_key'])
@Entity('leads')
export class Lead {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  name: string;

  /** Stored in canonical E.164 format (+919876543210). Nullable — manual/walk-in leads may not have a mobile. */
  @Column({ length: 20, nullable: true })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  city: string;

  @Column({ nullable: true })
  state: string;

  @Column({ nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 20 })
  source: LeadSource;

  @Column({ type: 'varchar', length: 20, default: LeadStatus.NEW })
  status: LeadStatus;

  @Column({ nullable: true })
  assigned_to: number;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ type: 'timestamptz', nullable: true })
  follow_up_date: Date;

  @Column({ type: 'text', nullable: true })
  product_interest: string;

  @Column({ type: 'text', nullable: true })
  context: string;

  @Column({ type: 'text', nullable: true })
  requirement_note: string;

  @Column({ nullable: true })
  utm_source: string;

  @Column({ nullable: true })
  utm_campaign: string;

  @Column({ type: 'varchar', length: 10, default: LeadPriority.MEDIUM })
  lead_priority: LeadPriority;

  @Column({ type: 'varchar', length: 20, default: LeadStage.NEW })
  stage: LeadStage;

  @Column({ nullable: true })
  customer_id: number;

  /**
   * @deprecated Reverse-link not populated by any code path.
   * Quotations are linked via quotation.lead_id — read quotations via findOne() journey.quotations.
   * Written only by markConverted() and createQuotation(). Candidate for removal in a future migration.
   */
  @Column({ nullable: true })
  quotation_id: number;

  @Column({ nullable: true })
  whatsapp_chat_id: string;

  @Column({ type: 'jsonb', nullable: true })
  raw_payload: Record<string, any>;

  @Column({ nullable: true, unique: true })
  external_id: string;

  /** Deterministic hash of (phone | product_interest | context) used for 24-hour dedup.
   *  Null for anonymous leads (no phone) so every anonymous click always creates a new lead. */
  @Column({ nullable: true, length: 64 })
  idempotency_key: string;

  /** WhatsApp message ID (_serialized) — unique per message, used to deduplicate event storms. */
  @Column({ nullable: true })
  whatsappMessageId: string;

  /** True when whatsappMessageId came from msg.id._serialized; false when the SHA-256 fallback was used. */
  @Column({ default: false })
  hasSerializedId: boolean;

  @Column({ type: 'varchar', length: 50, nullable: true })
  lead_source_label: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  channel: string;

  @Column({ type: 'text', nullable: true })
  landing_page: string;

  /**
   * @deprecated Superseded by lead_quality = 'DUPLICATE'.
   * Always written as false for new leads since requirement-aware dedup (Phase 19 Step 7)
   * ensures true phone+requirement duplicates never create new rows.
   * Legacy rows (pre-Phase 19) may still carry true here.
   * Removal requires a DB migration — keep until a planned migration cycle.
   */
  @Column({ default: false })
  duplicate_flag: boolean;

  /** Auto-computed behavioral tags: ["high_intent", "slow_response", "bulk_buyer"] */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

  /** All context labels seen for this lead across touch-points, deduplicated. */
  @Column('text', { array: true, default: () => 'ARRAY[]::text[]' })
  contextHistory: string[];

  /** Full journey of context labels, pipe-separated ("META – Lead Form | SHOPIFY – WhatsApp Click"). */
  @Column({ type: 'text', nullable: true })
  context_history: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: true })
  is_phone_valid: boolean;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lead_quality: LeadQuality;

  /** 0–100 quality score: higher = more actionable for sales team. */
  @Column({ type: 'int', nullable: true })
  quality_score: number;

  /** Set to NOW() whenever an INBOUND WhatsApp message arrives from this lead's phone. */
  @Column({ type: 'timestamptz', nullable: true })
  last_customer_reply_at: Date;

  /** Set to NOW() only when a human salesman sends a WA message (sentBy IS NOT NULL).
   *  Automated system messages do NOT set this — they must not clear the WAITING badge. */
  @Column({ type: 'timestamptz', nullable: true })
  last_salesman_reply_at: Date;

  /** Permanent human-readable CRM reference (LD-2026-000001). Set once on creation, never changed. */
  @Index('idx_leads_lead_ref', { unique: true })
  @Column({ nullable: true, length: 20, unique: true })
  lead_ref: string;

  /** When automation was snoozed until (NULL = not snoozed). Cron auto-resumes when this passes. */
  @Column({ type: 'timestamptz', nullable: true })
  automation_snooze_until: Date;

  /** Reason given by user when snoozing or pausing automation — required for accountability. */
  @Column({ type: 'text', nullable: true })
  automation_snooze_reason: string;

  @Column({ nullable: true })
  created_by: number;

  // ── Structured workflow memory ────────────────────────────────────────────────
  // Written only by logAction() and update(). Never parsed from note text.

  /** Fine-grained operational state — drives script, urgency, SLA, queue priority. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  workflow_state: WorkflowState;

  /** Last structured call outcome logged via logStructuredOutcome. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  last_outcome_type: OutcomeType;

  /** Last objection type from a NOT_INTERESTED outcome. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  last_objection_type: string;

  /** Total CALL notes ever logged for this lead. Atomic counter — incremented by SQL. */
  @Column({ type: 'int', default: 0 })
  call_attempt_count: number;

  /** Consecutive no-answer streak. Resets to 0 on any positive contact (INTERESTED/LATER). */
  @Column({ type: 'int', default: 0 })
  no_answer_count: number;

  /** Timestamp of last logged CALL outcome — replaces note MAX(created_at) query. */
  @Column({ type: 'timestamptz', nullable: true })
  last_contacted_at: Date;

  /** Machine-driven SLA deadline for queue priority and escalation.
   *  Distinct from follow_up_date (human-promised callback time).
   *  Written atomically at every workflow_state transition by computeNextActionDue(). */
  @Column({ type: 'timestamptz', nullable: true })
  next_action_due_at: Date;

  /** When the current workflow_state was entered. Powers SLA breach detection and stage aging. */
  @Column({ type: 'timestamptz', nullable: true })
  workflow_state_entered_at: Date;

  /** True only when a manager explicitly toggled automation off via the manual pause control.
   *  Unlike the automation_off tag (set by both manual pause and snooze), this flag
   *  is NOT cleared by resumeExpiredSnoozes() — so manual pauses survive snooze expiry. */
  @Column({ default: false })
  automation_manually_paused: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

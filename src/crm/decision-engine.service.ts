import { Injectable } from '@nestjs/common';
import {
  Lead,
  LeadSource,
  LeadStatus,
  WorkflowState,
} from './entities/lead.entity';

export type ActionKey =
  | 'CALL'
  | 'FOLLOWUP'
  | 'SEND_QUOTE'
  | 'CHASE_QUOTE'
  | 'REENGAGE'
  | 'NONE';

export interface NextAction {
  action: ActionKey;
  label: string;
  buttonText: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  script: string;
  nextStatusOnComplete: string | null;
  /** For NO_ANSWER retries — recommended delay before next attempt (minutes). */
  suggestedRetryMins?: number;
}

export interface OutcomeHistory {
  callAttempts: number;
  noAnswerCount: number;
  laterCount: number;
  lastOutcomeType:
    | 'INTERESTED'
    | 'NO_ANSWER'
    | 'LATER'
    | 'NOT_INTERESTED'
    | null;
  lastCallAt: Date | null;
  lastObjectionType: string | null;
  callbackPromisedAt: Date | null;
  /** Structured workflow state read directly from leads table — preferred over lastOutcomeType derivation. */
  workflowState?: WorkflowState | null;
}

export interface DecisionContext {
  score: number;
  nextAction: NextAction;
  urgencyKeywords: string[];
  ageHours: number;
  followUpOverdueDays: number | null;
  outcomeHistory: OutcomeHistory;
}

// ── SLA computation ───────────────────────────────────────────────────────────
// Single source of truth for all machine-driven action deadlines.
// Called at every workflow_state transition to set next_action_due_at.
// Mirrors NO_ANSWER_RETRY_MINS exactly — do not drift these values.

const HOT_FIRST_CALL_SOURCES: string[] = [
  LeadSource.META,
  LeadSource.GOOGLE,
  LeadSource.WHATSAPP,
  LeadSource.SHOPIFY,
];

export function computeNextActionDue(
  state: WorkflowState | null,
  source: string,
  followUpDate: Date | null,
  now: Date = new Date(),
): Date | null {
  const h = (n: number) => new Date(now.getTime() + n * 3_600_000);

  switch (state) {
    case WorkflowState.FIRST_CALL:
      return HOT_FIRST_CALL_SOURCES.includes(source) ? h(1) : h(4);

    case WorkflowState.FOLLOW_UP:
      return followUpDate && followUpDate > now ? followUpDate : h(24);

    case WorkflowState.NO_ANSWER_1:
      return h(8);
    case WorkflowState.NO_ANSWER_2:
      return h(24);
    case WorkflowState.NO_ANSWER_ESC:
      return h(48);

    case WorkflowState.CALLBACK_WAIT:
      // followUpDate IS the promised callback time — use it as the SLA clock
      return followUpDate ?? h(24);

    case WorkflowState.SEND_QUOTATION:
      return h(2);
    case WorkflowState.CHASE_QUOTATION:
      return h(72);
    case WorkflowState.NEGOTIATING:
      return h(48);

    case WorkflowState.NURTURE:
      return followUpDate && followUpDate > now ? followUpDate : h(24 * 30);

    case WorkflowState.CONVERTED:
    case WorkflowState.LOST:
    default:
      return null;
  }
}

// ── SLA status classifier ─────────────────────────────────────────────────────
// Single reusable helper — do not inline these thresholds anywhere else.

export function computeSlaStatus(
  nextActionDueAt: Date | null | undefined,
  now: Date = new Date(),
): 'NONE' | 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'CRITICAL' {
  if (!nextActionDueAt) return 'NONE';
  const diffMs = new Date(nextActionDueAt).getTime() - now.getTime(); // positive = future
  if (diffMs > 2 * 3_600_000) return 'ON_TIME'; // >2h away
  if (diffMs >= 0) return 'DUE_SOON'; // 0–2h
  if (diffMs >= -24 * 3_600_000) return 'OVERDUE'; // <24h past
  return 'CRITICAL'; // >24h past
}

// ── Queue tier classifier ─────────────────────────────────────────────────────
// Maps each lead to an operational priority tier (1 = highest, 0 = excluded).
// Tiers are checked top-down; first match wins.
// Pure function — no I/O, called once per lead in getQueue().

export function computeQueueTier(lead: Lead, nowMs: number): number {
  const state = lead.workflow_state;
  const dueMs = lead.next_action_due_at
    ? new Date(lead.next_action_due_at).getTime()
    : null;
  const tags = Array.isArray(lead.tags) ? lead.tags : [];

  // Tier 1 — Callback imminent: promised callback is due within 30 min, or already overdue
  if (
    state === WorkflowState.CALLBACK_WAIT &&
    dueMs !== null &&
    dueMs <= nowMs + 30 * 60_000
  ) {
    return 1;
  }

  // Tier 2 — SEND_QUOTATION: revenue-hot, always outranks generic SLA breach
  if (state === WorkflowState.SEND_QUOTATION) {
    return 2;
  }

  // Tier 3 — SLA breach for standard workflow states
  // NO_ANSWER_ESC is intentionally excluded — it is an escalation state (tier 4)
  const breachable = new Set<WorkflowState>([
    WorkflowState.FIRST_CALL,
    WorkflowState.FOLLOW_UP,
    WorkflowState.NO_ANSWER_1,
    WorkflowState.NO_ANSWER_2,
    WorkflowState.CHASE_QUOTATION,
    WorkflowState.NEGOTIATING,
    WorkflowState.CALLBACK_WAIT,
  ]);
  if (
    breachable.has(state as WorkflowState) &&
    dueMs !== null &&
    dueMs < nowMs
  ) {
    return 3;
  }

  // Tier 4 — Escalation: requires manager attention regardless of SLA status
  if (
    state === WorkflowState.NO_ANSWER_ESC ||
    tags.includes('needs_manager_review')
  ) {
    return 4;
  }

  // Tier 5 — Active pipeline: within SLA, needs routine action
  const active = new Set<WorkflowState>([
    WorkflowState.FIRST_CALL,
    WorkflowState.FOLLOW_UP,
    WorkflowState.CHASE_QUOTATION,
    WorkflowState.NEGOTIATING,
  ]);
  if (active.has(state as WorkflowState)) {
    return 5;
  }

  // Tier 6 — Nurture reactivation: re-engagement window has opened
  if (state === WorkflowState.NURTURE && dueMs !== null && dueMs <= nowMs) {
    return 6;
  }

  // Tier 0 — Not in operational queue:
  // future CALLBACK_WAIT (>30 min away), future NURTURE, CONVERTED, LOST, null state
  return 0;
}

// ── Workflow rank — higher number = more advanced state ───────────────────────
// Regression protection: if a lead is in a protected state (SEND_QUOTATION,
// CHASE_QUOTATION, NEGOTIATING, CONVERTED), a status change that would map to
// a lower-ranked workflow state is silently skipped for non-bypass roles.

export const WORKFLOW_RANK: Record<WorkflowState, number> = {
  [WorkflowState.FIRST_CALL]: 1,
  [WorkflowState.NO_ANSWER_1]: 2,
  [WorkflowState.FOLLOW_UP]: 2,
  [WorkflowState.NURTURE]: 2,
  [WorkflowState.NO_ANSWER_2]: 3,
  [WorkflowState.CALLBACK_WAIT]: 3,
  [WorkflowState.NO_ANSWER_ESC]: 4,
  [WorkflowState.SEND_QUOTATION]: 5,
  [WorkflowState.CHASE_QUOTATION]: 6,
  [WorkflowState.NEGOTIATING]: 7,
  [WorkflowState.CONVERTED]: 10,
  [WorkflowState.LOST]: 10,
};

// Allowed forward transitions per state.
// Admin/COO roles bypass all transition checks (isBypassRole = true).
const WORKFLOW_TRANSITIONS: Partial<Record<WorkflowState, WorkflowState[]>> = {
  [WorkflowState.FIRST_CALL]: [
    WorkflowState.FOLLOW_UP,
    WorkflowState.NO_ANSWER_1,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.FOLLOW_UP]: [
    WorkflowState.SEND_QUOTATION,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.NO_ANSWER_1,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.NO_ANSWER_1]: [
    WorkflowState.NO_ANSWER_2,
    WorkflowState.FOLLOW_UP,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.NO_ANSWER_2]: [
    WorkflowState.NO_ANSWER_ESC,
    WorkflowState.FOLLOW_UP,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.NO_ANSWER_ESC]: [
    WorkflowState.FOLLOW_UP,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.CALLBACK_WAIT]: [
    WorkflowState.FOLLOW_UP,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.NO_ANSWER_1,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.SEND_QUOTATION]: [
    WorkflowState.CHASE_QUOTATION,
    WorkflowState.NEGOTIATING,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.CHASE_QUOTATION]: [
    WorkflowState.NEGOTIATING,
    WorkflowState.CALLBACK_WAIT,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.NEGOTIATING]: [
    WorkflowState.CONVERTED,
    WorkflowState.CHASE_QUOTATION,
    WorkflowState.NURTURE,
    WorkflowState.LOST,
  ],
  [WorkflowState.NURTURE]: [
    WorkflowState.FIRST_CALL,
    WorkflowState.FOLLOW_UP,
    WorkflowState.SEND_QUOTATION,
    WorkflowState.LOST,
  ],
  [WorkflowState.CONVERTED]: [],
  [WorkflowState.LOST]: [WorkflowState.FIRST_CALL, WorkflowState.FOLLOW_UP],
};

/**
 * Returns true if the from→to workflow transition is valid.
 * isBypassRole = true skips all checks (Admin/COO).
 */
export function isValidWorkflowTransition(
  from: WorkflowState | null,
  to: WorkflowState,
  isBypassRole = false,
): boolean {
  if (isBypassRole) return true;
  if (!from) return true; // No prior state — any initial assignment is valid
  const allowed = WORKFLOW_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

const SOURCE_SCORES: Record<string, number> = {
  OLD_CUSTOMER: 38,
  REFERRAL: 35,
  WALK_IN: 32,
  EXHIBITION: 30,
  FIELD_VISIT: 30,
  DEALER_REFERENCE: 28,
  BUSINESS_CARD: 25,
  IMPORTED: 18,
  INDIAMART: 30,
  DIRECT: 28,
  META: 25,
  GOOGLE: 22,
  LINKEDIN: 22,
  WHATSAPP: 20,
  SHOPIFY: 15,
  MANUAL: 28,
  META_ADS: 25,
  GOOGLE_ADS: 22,
  DIRECT_CALL: 28,
};

const PRIORITY_BONUS: Record<string, number> = {
  HIGH: 20,
  MEDIUM: 10,
  LOW: 0,
};

const SOURCE_LABELS: Record<string, string> = {
  INDIAMART: 'IndiaMart',
  META: 'Facebook',
  GOOGLE: 'Google',
  LINKEDIN: 'LinkedIn',
  SHOPIFY: 'our website',
  WHATSAPP: 'WhatsApp',
  DIRECT: 'Direct',
  WALK_IN: 'Walk-In',
  REFERRAL: 'Reference',
  EXHIBITION: 'Exhibition',
  FIELD_VISIT: 'Field Visit',
  OLD_CUSTOMER: 'Old Customer',
  DEALER_REFERENCE: 'Dealer Reference',
  BUSINESS_CARD: 'Business Card',
  IMPORTED: 'Imported',
  MANUAL: 'Direct',
  META_ADS: 'Facebook',
  GOOGLE_ADS: 'Google',
  DIRECT_CALL: 'Direct',
};

const URGENCY_WORDS = [
  'urgent',
  'urgently',
  'immediately',
  'asap',
  'today',
  'tomorrow',
  'this week',
  'quick',
  'fast',
  'quickly',
  'rush',
  'early',
  'need now',
];

// Retry timing rotation for NO_ANSWER — each attempt uses a different time slot
// so we don't always call at the same time the customer missed
const NO_ANSWER_RETRY_MINS = [
  24 * 60, // attempt 1 → tomorrow 9am (handled by caller as preset)
  8 * 60, // attempt 2 → same day 4pm slot (~8h later)
  36 * 60, // attempt 3 → day after tomorrow 9am
];

function noAnswerNextAction(
  n: number,
  firstName: string,
  product: string,
): NextAction {
  if (n === 0) {
    // Shouldn't happen but guard
    return {
      action: 'CALL',
      label: 'Retry Call',
      buttonText: 'Log Call',
      urgency: 'MEDIUM',
      nextStatusOnComplete: null,
      suggestedRetryMins: 24 * 60,
      script: `Call ${firstName} again regarding ${product}.`,
    };
  }
  if (n === 1) {
    return {
      action: 'CALL',
      label: '📵 No Answer — Retry (Attempt 2)',
      buttonText: 'Log Call',
      urgency: 'MEDIUM',
      nextStatusOnComplete: null,
      suggestedRetryMins: 8 * 60,
      script:
        `Namaste ${firstName}! Calling from Hesh Store regarding your enquiry about ${product}.\n\n` +
        `This is a second attempt — try a different time of day than the first call.\n\n` +
        `If connected: Resume the discovery conversation from the beginning.\n` +
        `If not reached: Send WhatsApp message and schedule one more attempt.`,
    };
  }
  if (n === 2) {
    return {
      action: 'CALL',
      label: '📵 No Answer — Retry (Attempt 3)',
      buttonText: 'Log Call',
      urgency: 'MEDIUM',
      nextStatusOnComplete: null,
      suggestedRetryMins: 36 * 60,
      script:
        `Namaste ${firstName}! Third attempt for ${product} enquiry.\n\n` +
        `If still unreachable: Send a WhatsApp message and check with the manager\n` +
        `whether to keep attempting or close this lead.\n\n` +
        `WhatsApp script: "Namaste ${firstName}, we have tried calling you regarding\n` +
        `your enquiry about ${product}. Please reply here or call us back."`,
    };
  }
  // n >= 3 — escalate
  return {
    action: 'CALL',
    label: `⚠️ Escalate — ${n + 1} No Answers`,
    buttonText: 'Log Final Attempt',
    urgency: 'HIGH',
    nextStatusOnComplete: null,
    suggestedRetryMins: 48 * 60,
    script:
      `${n + 1} unanswered calls for ${product} enquiry.\n\n` +
      `Recommended actions:\n` +
      `1. Send a final WhatsApp message.\n` +
      `2. Flag for manager review — consider reassigning or closing.\n` +
      `3. If no response within 48h after WhatsApp, mark as Lost.\n\n` +
      `WhatsApp: "Namaste ${firstName}, we have been trying to reach you about\n` +
      `${product}. Please let us know if you are still interested."`,
  };
}

function notInterestedNextAction(
  objectionType: string | null,
  firstName: string,
  product: string,
): NextAction {
  switch (objectionType) {
    case 'HIGH_PRICE':
      return {
        action: 'FOLLOWUP',
        label: 'Re-engage: Price Objection — 14 days',
        buttonText: 'Schedule Re-engage',
        urgency: 'LOW',
        nextStatusOnComplete: LeadStatus.CONTACTED,
        script:
          `Namaste ${firstName}! Following up on ${product}.\n\n` +
          `We have revised pricing options available — would you like to take a look?\n` +
          `Bulk and seasonal discounts may apply. Min pricing is visible in our catalogue.\n\n` +
          `Goal: Reopen the conversation with a fresh pricing angle.`,
      };
    case 'TIMING':
      return {
        action: 'FOLLOWUP',
        label: 'Re-engage: Timing — 30 days',
        buttonText: 'Schedule Re-engage',
        urgency: 'LOW',
        nextStatusOnComplete: LeadStatus.CONTACTED,
        script:
          `Namaste ${firstName}! Calling from Hesh Store — following up on ${product}.\n\n` +
          `You had mentioned timing was not right earlier. Is now a better time to discuss?\n\n` +
          `Keep the call short: confirm interest, collect updated requirements.`,
      };
    case 'EMI':
      return {
        action: 'FOLLOWUP',
        label: 'Re-engage: EMI — 7 days',
        buttonText: 'Schedule Re-engage',
        urgency: 'LOW',
        nextStatusOnComplete: LeadStatus.CONTACTED,
        script:
          `Namaste ${firstName}! Regarding your interest in ${product}.\n\n` +
          `We have EMI options available via Razorpay (HDFC, ICICI, Axis, SBI).\n` +
          `Tenures: 3, 6, 9, 12 months. Min order ₹5,000.\n\n` +
          `Would you like me to send the EMI payment link on WhatsApp?`,
      };
    case 'COMPETITOR':
      return {
        action: 'REENGAGE',
        label: 'Re-engage or Close — 60 days',
        buttonText: 'Schedule Long-term Re-engage',
        urgency: 'LOW',
        nextStatusOnComplete: LeadStatus.CONTACTED,
        script:
          `Namaste ${firstName}! Hope the purchase went well.\n\n` +
          `If you ever need ${product} in the future, we would love to help.\n` +
          `We frequently run offers — shall I keep you posted?\n\n` +
          `If no interest: Respect the decision and close the lead.`,
      };
    case 'QUALITY':
      return {
        action: 'FOLLOWUP',
        label: 'Escalate: Quality Concern — Manager Review',
        buttonText: 'Escalate to Manager',
        urgency: 'MEDIUM',
        nextStatusOnComplete: null,
        script:
          `Namaste ${firstName}! I understand you had concerns about quality of ${product}.\n\n` +
          `I would like to connect you with our senior team who can share:\n` +
          `• Customer references and reviews\n` +
          `• Product samples (for bulk orders)\n` +
          `• Quality certifications\n\n` +
          `Would that work for you?`,
      };
    case 'NOT_NEEDED':
      return {
        action: 'NONE',
        label: 'No Requirement — Close Lead',
        buttonText: 'Mark Lost',
        urgency: 'LOW',
        nextStatusOnComplete: null,
        script: 'Customer confirmed no requirement. Recommend marking as Lost.',
      };
    case 'CREDIT':
      return {
        action: 'FOLLOWUP',
        label: 'Escalate: Credit Terms — Manager',
        buttonText: 'Escalate to Manager',
        urgency: 'MEDIUM',
        nextStatusOnComplete: null,
        script:
          `Namaste ${firstName}! Regarding the credit terms for ${product}.\n\n` +
          `Our standard policy is advance payment, but regular customers\n` +
          `(3+ orders) can discuss credit terms with the manager directly.\n\n` +
          `Shall I connect you with the manager to discuss?`,
      };
    default:
      return {
        action: 'FOLLOWUP',
        label: 'Re-engage — 30 days',
        buttonText: 'Schedule Re-engage',
        urgency: 'LOW',
        nextStatusOnComplete: LeadStatus.CONTACTED,
        script:
          `Namaste ${firstName}! Following up on your earlier interest in ${product}.\n\n` +
          `Circumstances may have changed — are you open to a quick discussion?`,
      };
  }
}

@Injectable()
export class DecisionEngineService {
  detectUrgencyKeywords(lead: Lead): string[] {
    const text =
      `${lead.notes ?? ''} ${lead.product_interest ?? ''}`.toLowerCase();
    return URGENCY_WORDS.filter((w) => text.includes(w));
  }

  scoreLead(lead: Lead): number {
    let score = 0;

    score += SOURCE_SCORES[lead.source] ?? 10;
    score += PRIORITY_BONUS[lead.lead_priority] ?? 10;

    if (this.detectUrgencyKeywords(lead).length > 0) score += 15;

    const ageHours =
      (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;
    if (ageHours < 1) score += 15;
    else if (ageHours < 24) score += 8;
    else if (ageHours > 168) score -= 10;

    // Overdue penalty: prefer next_action_due_at (machine SLA) over follow_up_date
    const dueAt = lead.next_action_due_at ?? lead.follow_up_date;
    if (dueAt) {
      const overdueDays = (Date.now() - new Date(dueAt).getTime()) / 86_400_000;
      if (overdueDays > 0) score -= Math.min(20, Math.floor(overdueDays) * 5);
    }

    // Stage value bonus — workflow_state preferred over status for precision
    if (
      lead.workflow_state === WorkflowState.SEND_QUOTATION ||
      lead.workflow_state === WorkflowState.NEGOTIATING
    )
      score += 15;
    else if (lead.workflow_state === WorkflowState.CHASE_QUOTATION) score += 10;
    else if (lead.status === LeadStatus.INTERESTED) score += 10;
    else if (lead.status === LeadStatus.CONTACTED) score += 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  getNextAction(lead: Lead, history?: OutcomeHistory): NextAction {
    const firstName = (lead.name ?? 'there').split(' ')[0];
    const product = lead.product_interest ?? 'our products';
    const sourceLabel = SOURCE_LABELS[lead.source] ?? lead.source;
    const isOverdue =
      !!lead.follow_up_date &&
      new Date(lead.follow_up_date).getTime() < Date.now();

    const wfState = history?.workflowState ?? null;

    // ── Primary branch: structured workflow_state (deterministic) ─────────────
    // This replaces all emoji-prefix inference. Only falls through to status-switch
    // for leads that pre-date the workflow memory columns (wfState === null).
    if (wfState) {
      switch (wfState) {
        case WorkflowState.FIRST_CALL:
          return {
            action: 'CALL',
            label: 'Make First Call',
            buttonText: 'Log Call → Mark Contacted',
            urgency: 'HIGH',
            nextStatusOnComplete: LeadStatus.CONTACTED,
            script:
              `Namaste ${firstName}! I am calling from Hesh Store regarding your enquiry about ${product} through ${sourceLabel}.\n\n` +
              `Please ask:\n` +
              `1. What exactly are you looking for?\n` +
              `2. What is your approximate budget?\n` +
              `3. When do you need this by?\n\n` +
              `If they hesitate: "I am just trying to understand your requirement so I can help you better."`,
          };

        case WorkflowState.FOLLOW_UP:
          return {
            action: 'FOLLOWUP',
            label: isOverdue ? '⚠️ Follow-up Overdue' : 'Follow Up Call',
            buttonText: 'Log Call → Mark Interested',
            urgency: isOverdue ? 'HIGH' : 'MEDIUM',
            nextStatusOnComplete: LeadStatus.INTERESTED,
            script:
              `Namaste ${firstName}! This is a follow-up call about ${product}.\n\n` +
              `Have you had a chance to think about it?\n\n` +
              `Key questions:\n` +
              `1. Final budget range?\n` +
              `2. Quantity needed?\n` +
              `3. Any specific requirements?\n\n` +
              `Goal: Confirm interest and collect info to send a quotation.`,
          };

        case WorkflowState.NO_ANSWER_1:
          return noAnswerNextAction(1, firstName, product);

        case WorkflowState.NO_ANSWER_2:
          return noAnswerNextAction(2, firstName, product);

        case WorkflowState.NO_ANSWER_ESC:
          return noAnswerNextAction(
            history?.noAnswerCount ?? 3,
            firstName,
            product,
          );

        case WorkflowState.CALLBACK_WAIT: {
          const cb = history?.callbackPromisedAt
            ? new Date(history.callbackPromisedAt)
            : null;
          const diffMins = cb
            ? Math.round((cb.getTime() - Date.now()) / 60_000)
            : 0;
          const isCallbackOverdue = diffMins < 0;
          const diffLabel =
            diffMins <= 0
              ? 'now'
              : diffMins < 60
                ? `${diffMins}m`
                : diffMins < 1440
                  ? `${Math.floor(diffMins / 60)}h`
                  : `${Math.floor(diffMins / 1440)}d`;
          return {
            action: 'CALL',
            label: isCallbackOverdue
              ? '⚠️ Callback Overdue'
              : `⏰ Callback in ${diffLabel}`,
            buttonText: 'Log Callback',
            urgency:
              isCallbackOverdue || diffMins < 60
                ? 'HIGH'
                : diffMins < 360
                  ? 'MEDIUM'
                  : 'LOW',
            nextStatusOnComplete: null,
            script:
              `Namaste ${firstName}! Calling as promised regarding ${product}.\n\n` +
              `You had asked us to call back — we are right on time.\n\n` +
              `Resume from where the last conversation left off.\n` +
              `Goal: Confirm interest and move to the next stage.`,
          };
        }

        case WorkflowState.SEND_QUOTATION:
          return {
            action: 'SEND_QUOTE',
            label: 'Send Quotation',
            buttonText: 'Create Quotation',
            urgency: 'HIGH',
            nextStatusOnComplete: LeadStatus.QUOTATION,
            script:
              `Namaste ${firstName}! I am calling to finalise the quotation for ${product}.\n\n` +
              `Just need to confirm:\n` +
              `1. Final quantity?\n` +
              `2. Delivery address / city?\n` +
              `3. Any special customisation?\n\n` +
              `Say: "I will send the formal quotation within the hour."`,
          };

        case WorkflowState.CHASE_QUOTATION:
          return {
            action: 'CHASE_QUOTE',
            label: isOverdue
              ? '⚠️ Quote Follow-up Overdue'
              : 'Follow Up on Quotation',
            buttonText: 'Log Response → Close Deal',
            urgency: isOverdue ? 'HIGH' : 'MEDIUM',
            nextStatusOnComplete: LeadStatus.CONVERTED,
            script:
              `Namaste ${firstName}! Calling to check if you reviewed the quotation for ${product}.\n\n` +
              `If questions: Answer directly.\n` +
              `If price concern: "Let me check with my team if there is any flexibility."\n` +
              `If not seen: "Let me resend it now — can you confirm your WhatsApp?"\n` +
              `If ready to order: "Excellent! I will initiate the order process right away."`,
          };

        case WorkflowState.NEGOTIATING:
          return {
            action: 'CHASE_QUOTE',
            label: 'Negotiation in Progress',
            buttonText: 'Log Outcome',
            urgency: 'HIGH',
            nextStatusOnComplete: LeadStatus.CONVERTED,
            script:
              `Namaste ${firstName}! Following up on the quotation discussion for ${product}.\n\n` +
              `Have you had a chance to review our proposal?\n\n` +
              `If price concern: "What figure were you expecting? I will check with my team."\n` +
              `If timeline: "We can prioritise your order — what date works?"\n` +
              `Goal: Close the deal or schedule a final decision call.`,
          };

        case WorkflowState.NURTURE:
          return notInterestedNextAction(
            history?.lastObjectionType ?? null,
            firstName,
            product,
          );

        case WorkflowState.CONVERTED:
          return {
            action: 'NONE',
            label: 'Lead Converted ✓',
            buttonText: 'View Order',
            urgency: 'LOW',
            nextStatusOnComplete: null,
            script:
              'This lead has been successfully converted. No further action required.',
          };

        case WorkflowState.LOST:
          return {
            action: 'REENGAGE',
            label: 'Re-engage Lead',
            buttonText: 'Log Contact → Mark Contacted',
            urgency: 'LOW',
            nextStatusOnComplete: LeadStatus.CONTACTED,
            script:
              `Namaste ${firstName}! Hope you are doing well. Calling from Hesh Store.\n\n` +
              `We have new options for ${product} that might interest you. Do you have 2 minutes?\n\n` +
              `If open: Restart discovery conversation.\n` +
              `If busy: "Can I send you the details on WhatsApp?"`,
          };
      }
    }

    // ── Fallback: status-based routing for pre-migration leads ────────────────
    // Only reached when workflow_state is NULL (lead created before this phase).
    const noAnswerCount = history?.noAnswerCount ?? 0;
    const lastOutcome = history?.lastOutcomeType ?? null;

    if (
      history?.callbackPromisedAt &&
      new Date(history.callbackPromisedAt).getTime() > Date.now() &&
      lastOutcome === 'LATER'
    ) {
      const cb = new Date(history.callbackPromisedAt);
      const diffMins = Math.round((cb.getTime() - Date.now()) / 60_000);
      const diffLabel =
        diffMins < 60
          ? `${diffMins}m`
          : diffMins < 1440
            ? `${Math.floor(diffMins / 60)}h`
            : `${Math.floor(diffMins / 1440)}d`;
      return {
        action: 'CALL',
        label: `⏰ Callback due in ${diffLabel}`,
        buttonText: 'Log Call',
        urgency: diffMins < 60 ? 'HIGH' : diffMins < 360 ? 'MEDIUM' : 'LOW',
        nextStatusOnComplete: null,
        script: `Namaste ${firstName}! Calling as promised regarding ${product}.\n\nResume from where the last conversation left off.\nGoal: Confirm interest and move to the next stage.`,
      };
    }
    if (lastOutcome === 'NOT_INTERESTED' && history?.lastObjectionType) {
      return notInterestedNextAction(
        history.lastObjectionType,
        firstName,
        product,
      );
    }
    if (lastOutcome === 'NO_ANSWER' && noAnswerCount > 0) {
      return noAnswerNextAction(noAnswerCount, firstName, product);
    }

    switch (lead.status) {
      case LeadStatus.NEW:
        return {
          action: 'CALL',
          label: 'Make First Call',
          buttonText: 'Log Call → Mark Contacted',
          urgency: 'HIGH',
          nextStatusOnComplete: LeadStatus.CONTACTED,
          script: `Namaste ${firstName}! I am calling from Hesh Store regarding your enquiry about ${product} through ${sourceLabel}.\n\nPlease ask:\n1. What exactly are you looking for?\n2. What is your approximate budget?\n3. When do you need this by?\n\nIf they hesitate: "I am just trying to understand your requirement so I can help you better."`,
        };
      case LeadStatus.CONTACTED:
        return {
          action: 'FOLLOWUP',
          label: isOverdue ? '⚠️ Follow-up Overdue' : 'Follow Up Call',
          buttonText: 'Log Call → Mark Interested',
          urgency: isOverdue ? 'HIGH' : 'MEDIUM',
          nextStatusOnComplete: LeadStatus.INTERESTED,
          script: `Namaste ${firstName}! This is a follow-up call about ${product}.\n\nHave you had a chance to think about it?\n\nKey questions:\n1. Final budget range?\n2. Quantity needed?\n3. Any specific requirements?\n\nGoal: Confirm interest and collect info to send a quotation.`,
        };
      case LeadStatus.INTERESTED:
        return {
          action: 'SEND_QUOTE',
          label: 'Send Quotation',
          buttonText: 'Create Quotation',
          urgency: 'HIGH',
          nextStatusOnComplete: LeadStatus.QUOTATION,
          script: `Namaste ${firstName}! I am calling to finalise the quotation for ${product}.\n\nJust need to confirm:\n1. Final quantity?\n2. Delivery address / city?\n3. Any special customisation?\n\nSay: "I will send the formal quotation within the hour."`,
        };
      case LeadStatus.QUOTATION:
        return {
          action: 'CHASE_QUOTE',
          label: isOverdue
            ? '⚠️ Quote Follow-up Overdue'
            : 'Follow Up on Quotation',
          buttonText: 'Log Response → Close Deal',
          urgency: isOverdue ? 'HIGH' : 'MEDIUM',
          nextStatusOnComplete: LeadStatus.CONVERTED,
          script: `Namaste ${firstName}! Calling to check if you reviewed the quotation for ${product}.\n\nIf questions: Answer directly.\nIf price concern: "Let me check with my team if there is any flexibility."\nIf not seen: "Let me resend it now — can you confirm your WhatsApp?"\nIf ready to order: "Excellent! I will initiate the order process right away."`,
        };
      case LeadStatus.LOST:
        return {
          action: 'REENGAGE',
          label: 'Re-engage Lead',
          buttonText: 'Log Contact → Mark Contacted',
          urgency: 'LOW',
          nextStatusOnComplete: LeadStatus.CONTACTED,
          script: `Namaste ${firstName}! Hope you are doing well. Calling from Hesh Store.\n\nWe have new options for ${product} that might interest you. Do you have 2 minutes?\n\nIf open: Restart discovery conversation.\nIf busy: "Can I send you the details on WhatsApp?"`,
        };
      default:
        return {
          action: 'NONE',
          label: 'Lead Converted ✓',
          buttonText: 'View Order',
          urgency: 'LOW',
          nextStatusOnComplete: null,
          script:
            'This lead has been successfully converted. No further action required.',
        };
    }
  }

  getDecisionContext(lead: Lead, history?: OutcomeHistory): DecisionContext {
    const defaultHistory: OutcomeHistory = {
      callAttempts: 0,
      noAnswerCount: 0,
      laterCount: 0,
      lastOutcomeType: null,
      lastCallAt: null,
      lastObjectionType: null,
      callbackPromisedAt: null,
    };
    const h = history ?? defaultHistory;

    const score = this.scoreLead(lead);
    const nextAction = this.getNextAction(lead, h);
    const urgencyKeywords = this.detectUrgencyKeywords(lead);
    const ageHours = Math.round(
      (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000,
    );
    const followUpOverdueDays = lead.follow_up_date
      ? Math.max(
          0,
          Math.round(
            (Date.now() - new Date(lead.follow_up_date).getTime()) / 86_400_000,
          ),
        )
      : null;

    return {
      score,
      nextAction,
      urgencyKeywords,
      ageHours,
      followUpOverdueDays,
      outcomeHistory: h,
    };
  }
}

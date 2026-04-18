import { Injectable } from '@nestjs/common';
import { Lead, LeadStatus } from './entities/lead.entity';

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
}

export interface DecisionContext {
  score: number;
  nextAction: NextAction;
  urgencyKeywords: string[];
  ageHours: number;
  followUpOverdueDays: number | null;
}

const SOURCE_SCORES: Record<string, number> = {
  INDIAMART: 30,
  META_ADS: 25,
  GOOGLE_ADS: 22,
  DIRECT_CALL: 28,
  WHATSAPP: 20,
  SHOPIFY: 15,
  MANUAL: 10,
};

const PRIORITY_BONUS: Record<string, number> = {
  HIGH: 20,
  MEDIUM: 10,
  LOW: 0,
};

const SOURCE_LABELS: Record<string, string> = {
  INDIAMART: 'IndiaMart',
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  SHOPIFY: 'Shopify',
  WHATSAPP: 'WhatsApp',
  DIRECT_CALL: 'Direct Call',
  MANUAL: 'Manual',
};

const URGENCY_WORDS = [
  'urgent', 'urgently', 'immediately', 'asap', 'today', 'tomorrow',
  'this week', 'quick', 'fast', 'quickly', 'rush', 'early', 'need now',
];

@Injectable()
export class DecisionEngineService {
  detectUrgencyKeywords(lead: Lead): string[] {
    const text = `${lead.notes ?? ''} ${lead.product_interest ?? ''}`.toLowerCase();
    return URGENCY_WORDS.filter((w) => text.includes(w));
  }

  scoreLead(lead: Lead): number {
    let score = 0;

    score += SOURCE_SCORES[lead.source] ?? 10;
    score += PRIORITY_BONUS[lead.lead_priority] ?? 10;

    if (this.detectUrgencyKeywords(lead).length > 0) score += 15;

    const ageHours = (Date.now() - new Date(lead.created_at).getTime()) / 3_600_000;
    if (ageHours < 1) score += 15;
    else if (ageHours < 24) score += 8;
    else if (ageHours > 168) score -= 10;

    if (lead.follow_up_date) {
      const overdueDays = (Date.now() - new Date(lead.follow_up_date).getTime()) / 86_400_000;
      if (overdueDays > 0) score -= Math.min(20, Math.floor(overdueDays) * 5);
    }

    if (lead.status === LeadStatus.INTERESTED) score += 10;
    else if (lead.status === LeadStatus.CONTACTED) score += 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  getNextAction(lead: Lead): NextAction {
    const firstName = (lead.name ?? 'there').split(' ')[0];
    const product = lead.product_interest ?? 'our products';
    const sourceLabel = SOURCE_LABELS[lead.source] ?? lead.source;
    const isOverdue =
      !!lead.follow_up_date && new Date(lead.follow_up_date).getTime() < Date.now();

    switch (lead.status) {
      case LeadStatus.NEW:
        return {
          action: 'CALL',
          label: 'Make First Call',
          buttonText: 'Log Call → Mark Contacted',
          urgency: 'HIGH',
          nextStatusOnComplete: LeadStatus.CONTACTED,
          script:
            `Namaste ${firstName}! I am calling from Saachu regarding your enquiry about ${product} through ${sourceLabel}.\n\n` +
            `Please ask:\n` +
            `1. What exactly are you looking for?\n` +
            `2. What is your approximate budget?\n` +
            `3. When do you need this by?\n\n` +
            `If they hesitate: "I am just trying to understand your requirement so I can help you better."`,
        };

      case LeadStatus.CONTACTED:
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

      case LeadStatus.INTERESTED:
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

      case LeadStatus.QUOTATION:
        return {
          action: 'CHASE_QUOTE',
          label: isOverdue ? '⚠️ Quote Follow-up Overdue' : 'Follow Up on Quotation',
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

      case LeadStatus.LOST:
        return {
          action: 'REENGAGE',
          label: 'Re-engage Lead',
          buttonText: 'Log Contact → Mark Contacted',
          urgency: 'LOW',
          nextStatusOnComplete: LeadStatus.CONTACTED,
          script:
            `Namaste ${firstName}! Hope you are doing well. Calling from Saachu.\n\n` +
            `We have new options for ${product} that might interest you. Do you have 2 minutes?\n\n` +
            `If open: Restart discovery conversation.\n` +
            `If busy: "Can I send you the details on WhatsApp?"`,
        };

      default:
        return {
          action: 'NONE',
          label: 'Lead Converted ✓',
          buttonText: 'View Order',
          urgency: 'LOW',
          nextStatusOnComplete: null,
          script: 'This lead has been successfully converted. No further action required.',
        };
    }
  }

  getDecisionContext(lead: Lead): DecisionContext {
    const score = this.scoreLead(lead);
    const nextAction = this.getNextAction(lead);
    const urgencyKeywords = this.detectUrgencyKeywords(lead);
    const ageHours = Math.round((Date.now() - new Date(lead.created_at).getTime()) / 3_600_000);
    const followUpOverdueDays = lead.follow_up_date
      ? Math.max(
          0,
          Math.round((Date.now() - new Date(lead.follow_up_date).getTime()) / 86_400_000),
        )
      : null;

    return { score, nextAction, urgencyKeywords, ageHours, followUpOverdueDays };
  }
}

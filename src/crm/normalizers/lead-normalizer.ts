/**
 * Canonical lead normalization utilities shared across all source integrations.
 * All normalizers import from here — single source of truth.
 */
import { LeadSource } from '../entities/lead.entity';

// ─── Platform normalization ──────────────────────────────────────────────────

/** Canonical platform list. All sources collapse into one of these values. */
export const ALLOWED_PLATFORMS = [
  'SHOPIFY', 'META', 'GOOGLE', 'INDIAMART', 'LINKEDIN', 'WHATSAPP', 'DIRECT',
] as const;

export type Platform = typeof ALLOWED_PLATFORMS[number];

/**
 * Maps any raw source/platform string to the canonical platform list.
 * Unknown values always fall back to 'DIRECT' — never fail silently with
 * an arbitrary string that breaks analytics group-bys.
 */
export function normalizePlatform(input: string): Platform {
  const v = (input || '').toUpperCase().replace(/[\s_-]/g, '');

  if (v.includes('META') || v.includes('FACEBOOK') || v.includes('FB') || v.includes('INSTAGRAM')) return 'META';
  if (v.includes('SHOPIFY'))   return 'SHOPIFY';
  if (v.includes('GOOGLE'))    return 'GOOGLE';
  if (v.includes('INDIAMART')) return 'INDIAMART';
  if (v.includes('LINKEDIN'))  return 'LINKEDIN';
  if (v.includes('WHATSAPP'))  return 'WHATSAPP';

  return 'DIRECT';
}

// ─── Phone ───────────────────────────────────────────────────────────────────

/**
 * Returns phone in +E.164 format.
 * Defaults to India (+91) for bare 10-digit numbers.
 *
 * Examples:
 *   "9876543210"       → "+919876543210"
 *   "+91 9876543210"   → "+919876543210"
 *   "+1 5551234567"    → "+15551234567"
 *   "09876543210"      → "+919876543210"
 */
export function normalizePhone(raw: string, defaultCountryCode = '91'): string {
  if ((raw || '').trim().toLowerCase() === 'unknown') return 'unknown';

  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';

  // Already has country code embedded (more than 10 digits)
  if (digits.length > 10) return '+' + digits;

  // 10-digit bare number (Indian standard)
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;

  // 11-digit with leading 0 (e.g. 09876543210)
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+${defaultCountryCode}${digits.slice(1)}`;
  }

  // Best-effort for anything shorter — prepend default country code
  return `+${defaultCountryCode}${digits}`;
}

/** True if phone is in valid +E.164 format, or the sentinel "unknown" for Shopify leads without a phone. */
export function isValidPhone(phone: string): boolean {
  return phone === 'unknown' || /^\+\d{10,15}$/.test(phone);
}

// ─── Text utilities ──────────────────────────────────────────────────────────

export function toSentenceCase(s: string): string {
  if (!s) return s;
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Title-cases every word: "ravi kumar" → "Ravi Kumar", "RAVI KUMAR" → "Ravi Kumar" */
export function sentenceCaseWords(s: string): string {
  if (!s) return s;
  return s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Standardized lead shape ─────────────────────────────────────────────────

export interface StandardizedLead {
  name: string;
  phone: string;               // always +E.164
  email?: string;
  city?: string;
  product_interest?: string;
  requirement_note?: string;   // short human-readable need
  source: LeadSource;
  lead_source_label?: string;  // e.g. whatsapp_click, meta_lead_form
  channel?: string;            // WHATSAPP | CALL | FORM
  utm_source?: string;
  utm_campaign?: string;
  landing_page?: string;
  external_id?: string;
  raw_payload?: Record<string, any>;
}

type SourceType = 'shopify' | 'meta' | 'whatsapp' | 'indiamart' | 'manual';

/**
 * Universal normalizer — unifies raw payloads from any source into a
 * CRM-ready StandardizedLead. Use instead of calling source-specific
 * normalizers directly when you control the entry point.
 */
export function normalizeLeadData(rawInput: any, sourceType: SourceType): StandardizedLead {
  const phone = normalizePhone(rawInput.phone || rawInput.mobile || '');
  const name  = sentenceCaseWords(
    rawInput.name || rawInput.full_name || rawInput.contact_name || '',
  ) || 'Unknown Lead';
  const email = (rawInput.email || '').trim().toLowerCase() || undefined;
  const city  = sentenceCaseWords(rawInput.city || rawInput.location || '') || undefined;

  const base: Omit<StandardizedLead, 'source'> = { name, phone, email, city };

  switch (sourceType) {
    case 'shopify': {
      const action = rawInput.action || rawInput.lead_type || '';
      return {
        ...base,
        source: LeadSource.SHOPIFY,
        product_interest: rawInput.product || undefined,
        requirement_note: toSentenceCase(rawInput.message || rawInput.body || '') || undefined,
        lead_source_label: (action || 'shopify').slice(0, 50),
        channel: action.toLowerCase().includes('whatsapp') ? 'WHATSAPP' : 'FORM',
        utm_source: action || 'shopify',
        utm_campaign: rawInput.product || undefined,
        landing_page: rawInput.page_url || undefined,
        raw_payload: rawInput,
      };
    }

    case 'meta': {
      // rawInput here is the already-extracted flat object (not raw graph response)
      return {
        ...base,
        source: LeadSource.META,
        product_interest: rawInput.product_interest || undefined,
        requirement_note: toSentenceCase(rawInput.message || rawInput.product_interest || '') || undefined,
        lead_source_label: 'meta_lead_form',
        channel: 'FORM',
        utm_source: 'meta',
        utm_campaign: rawInput.campaign_name || undefined,
        external_id: rawInput.leadgen_id,
        raw_payload: rawInput,
      };
    }

    case 'whatsapp': {
      return {
        ...base,
        source: LeadSource.WHATSAPP,
        requirement_note: toSentenceCase(rawInput.body || '') || undefined,
        lead_source_label: 'inbound_message',
        channel: 'WHATSAPP',
        utm_source: 'whatsapp',
        raw_payload: rawInput,
      };
    }

    case 'indiamart': {
      return {
        ...base,
        source: LeadSource.INDIAMART,
        product_interest: rawInput.QUERY_PRODUCT_NAME || rawInput.SUBJECT || undefined,
        requirement_note: toSentenceCase(rawInput.QUERY_MESSAGE || '') || undefined,
        lead_source_label: 'indiamart_query',
        channel: 'FORM',
        utm_source: 'indiamart',
        external_id: rawInput.UNIQUE_QUERY_ID || rawInput.unique_query_id || undefined,
        raw_payload: rawInput,
      };
    }

    default:
      return { ...base, source: LeadSource.DIRECT, channel: 'FORM', utm_source: 'manual' };
  }
}

// ─── Display formatter ───────────────────────────────────────────────────────

export interface LeadDisplayFormat {
  header: string;     // "👤 Ravi Kumar"
  phone: string;      // "+919876543210"
  phoneLink: string;  // "tel:+919876543210"
  location: string;   // "📍 Chennai"
  product: string;    // "📦 Microfiber Cloth"
  note: string;       // "🧾 Need bulk 500 pcs"
  context: string;    // "🌐 META – meta_lead_form"
  platform: string;   // "META"
}

export function formatLeadDisplay(lead: {
  name: string;
  phone: string;
  city?: string;
  product_interest?: string;
  requirement_note?: string;
  source: string;
  lead_source_label?: string;
}): LeadDisplayFormat {
  const platform = sourceToPlatform(lead.source);
  const label    = lead.lead_source_label || lead.source;

  return {
    header:    `👤 ${lead.name}`,
    phone:     lead.phone,
    phoneLink: `tel:${lead.phone}`,
    location:  `📍 ${lead.city || 'Unknown'}`,
    product:   `📦 ${lead.product_interest || '-'}`,
    note:      `🧾 ${lead.requirement_note || '-'}`,
    context:   `🌐 ${platform} – ${label}`,
    platform,
  };
}

// Source values are now identical to platform labels — map is kept for legacy entries in DB
const LEGACY_SOURCE_MAP: Record<string, string> = {
  META_ADS:    'META',
  GOOGLE_ADS:  'GOOGLE',
  DIRECT_CALL: 'DIRECT',
  FACEBOOK:    'META',
  FB:          'META',
};

function sourceToPlatform(source: string): string {
  return LEGACY_SOURCE_MAP[source] ?? source;
}

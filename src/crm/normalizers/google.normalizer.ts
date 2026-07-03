import {
  normalizePhone,
  toSentenceCase,
  sentenceCaseWords,
} from './lead-normalizer';
import { LeadSource } from '../entities/lead.entity';
import { LeadContext, contextToLabel } from '../enums/lead-context.enum';

// Google Ads standard column IDs — everything else is a custom question answer.
const STANDARD_COLUMNS = new Set([
  'FULL_NAME',
  'PHONE_NUMBER',
  'EMAIL',
  'POSTAL_CODE',
  'CITY',
  'COUNTRY',
]);

/**
 * Normalize a Google Ads Lead Form Extension webhook payload into a CRM-ready DTO.
 *
 * Expected payload shape:
 * {
 *   google_key: string,          // auth — verified by caller before this runs
 *   lead_id: string,             // → external_id (idempotency)
 *   user_column_data: [
 *     { column_name: "FULL_NAME",     string_value: "Ravi Kumar"      },
 *     { column_name: "PHONE_NUMBER",  string_value: "+919876543210"   },
 *     { column_name: "EMAIL",         string_value: "ravi@example.com"},
 *     { column_name: "CITY",          string_value: "Chennai"         },
 *     { column_name: "Custom Q?",     string_value: "Microfiber Cloth"},
 *   ],
 *   campaign_id:   string,
 *   campaign_name: string,
 *   adgroup_id:    string,
 *   adgroup_name:  string,
 *   creative_id:   string,
 *   form_id:       string,
 *   gcl_id:        string,       // Google Click ID
 *   is_test:       boolean,
 *   submission_timestamp: string,
 * }
 */
export function normalizeGoogleLead(payload: any) {
  const cols: Array<{ column_name: string; string_value: string }> =
    payload.user_column_data ?? [];

  const get = (...names: string[]) => {
    for (const name of names) {
      const val = cols.find((c) => c.column_name === name)?.string_value;
      if (val?.trim()) return val.trim();
    }
    return '';
  };

  const phone = normalizePhone(get('PHONE_NUMBER'));

  // Custom question answers → product_interest and notes
  const customAnswers = cols
    .filter(
      (c) => !STANDARD_COLUMNS.has(c.column_name) && c.string_value?.trim(),
    )
    .map((c) => `${c.column_name.replace(/_/g, ' ')}: ${c.string_value.trim()}`)
    .join('\n');

  return {
    name: sentenceCaseWords(get('FULL_NAME')) || 'Unknown Lead',
    phone,
    email: get('EMAIL') || undefined,
    city: sentenceCaseWords(get('CITY', 'POSTAL_CODE')) || undefined,
    source: LeadSource.GOOGLE,
    product_interest: customAnswers || undefined,
    notes: customAnswers ? toSentenceCase(customAnswers) : undefined,
    context: contextToLabel(LeadContext.GOOGLE_ADS),
    lead_source_label: 'google_ads_lead_form',
    channel: 'FORM',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: payload.campaign_name || undefined,
    external_id: payload.lead_id ? String(payload.lead_id) : undefined,
    raw_payload: {
      lead_id: payload.lead_id,
      form_id: payload.form_id,
      campaign_id: payload.campaign_id,
      campaign_name: payload.campaign_name,
      adgroup_id: payload.adgroup_id,
      adgroup_name: payload.adgroup_name,
      creative_id: payload.creative_id,
      gcl_id: payload.gcl_id,
      is_test: payload.is_test,
      submission_timestamp: payload.submission_timestamp,
      user_column_data: cols,
    },
  };
}

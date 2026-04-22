import { normalizePhone, toSentenceCase, sentenceCaseWords } from './lead-normalizer';
import { LeadSource } from '../entities/lead.entity';

export function normalizeIndiaMart(payload: any) {
  const rawPhone = payload.SENDER_MOBILE || payload.sender_mobile || '';

  return {
    name:             sentenceCaseWords(payload.SENDER_NAME || payload.sender_name || 'Unknown Lead'),
    phone:            normalizePhone(rawPhone),
    email:            payload.SENDER_EMAIL || payload.sender_email || undefined,
    source:           LeadSource.INDIAMART,
    product_interest: payload.QUERY_PRODUCT_NAME || payload.SUBJECT || undefined,
    requirement_note: toSentenceCase(payload.QUERY_MESSAGE || '') || undefined,
    lead_source_label: 'indiamart_query',
    channel:          'FORM',
    utm_source:       'indiamart',
    external_id:      payload.UNIQUE_QUERY_ID || payload.unique_query_id || undefined,
    raw_payload:      payload,
  };
}

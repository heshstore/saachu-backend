import { LeadSource } from '../entities/lead.entity';

export function normalizeIndiaMart(payload: any) {
  return {
    name: payload.SENDER_NAME || payload.sender_name || 'Unknown',
    phone: payload.SENDER_MOBILE || payload.sender_mobile || '',
    email: payload.SENDER_EMAIL || payload.sender_email || '',
    source: LeadSource.INDIAMART,
    product_interest: payload.QUERY_PRODUCT_NAME || payload.SUBJECT || '',
    notes: payload.QUERY_MESSAGE || '',
    external_id: payload.UNIQUE_QUERY_ID || payload.unique_query_id || null,
    raw_payload: payload,
  };
}

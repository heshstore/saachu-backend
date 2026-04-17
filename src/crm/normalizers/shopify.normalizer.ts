import { LeadSource } from '../entities/lead.entity';

export function normalizeShopify(payload: any) {
  return {
    name: payload.name || payload.contact_name || 'Unknown',
    phone: payload.phone || payload.mobile || '',
    email: payload.email || '',
    source: LeadSource.SHOPIFY,
    product_interest: payload.message || payload.body || '',
    raw_payload: payload,
  };
}

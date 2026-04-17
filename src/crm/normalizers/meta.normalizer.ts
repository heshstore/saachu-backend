import { LeadSource } from '../entities/lead.entity';

export function normalizeMetaLead(fields: { name: string; values: string[] }[], leadgenId: string) {
  const get = (name: string) =>
    fields.find((f) => f.name === name)?.values?.[0] || '';

  return {
    name: get('full_name') || get('first_name') || 'Unknown',
    phone: get('phone_number') || get('phone') || '',
    email: get('email') || '',
    source: LeadSource.META_ADS,
    product_interest: get('product_interest') || get('message') || '',
    utm_source: 'meta',
    external_id: leadgenId,
    raw_payload: { leadgen_id: leadgenId, fields },
  };
}

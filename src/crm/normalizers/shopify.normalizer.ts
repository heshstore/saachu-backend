import * as crypto from 'crypto';
import { normalizePhone } from './lead-normalizer';
import { LeadSource } from '../entities/lead.entity';

function buildWebhookExternalId(phone: string, email: string): string | undefined {
  const p = phone.replace(/\D/g, '').slice(-10);
  const e = (email || '').toLowerCase().trim();
  const key = p || e;
  if (!key) return undefined;
  return 'sh_wh_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

export function normalizeShopify(payload: any) {
  const rawPhone = payload.phone || payload.mobile || '';
  const phone    = normalizePhone(rawPhone);
  const email    = payload.email || '';
  const action   = payload.type || '';

  return {
    name:             payload.name || payload.contact_name || 'Unknown Lead',
    phone,
    email:            email || undefined,
    source:           LeadSource.SHOPIFY,
    product_interest: payload.product || payload.product_title || undefined,
    notes:            payload.message || payload.body || undefined,
    lead_source_label: (action || 'shopify_webhook').slice(0, 50),
    channel:          action.toLowerCase().includes('whatsapp') ? 'WHATSAPP' : 'FORM',
    utm_source:       action || 'shopify_contact',
    landing_page:     payload.page_url || undefined,
    external_id:      buildWebhookExternalId(rawPhone, email),
    raw_payload:      payload,
  };
}

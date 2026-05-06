import { normalizePhone, toSentenceCase } from './lead-normalizer';
import { LeadSource } from '../entities/lead.entity';
import { LeadContext, contextToLabel } from '../enums/lead-context.enum';

interface MetaGraphResponse {
  field_data?: { name: string; values: string[] }[];
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
  [key: string]: any;
}

const STANDARD_FIELDS = new Set([
  'full_name', 'first_name', 'last_name',
  'phone_number', 'phone', 'mobile',
  'email', 'city', 'location',
]);

export function normalizeMetaLead(graphData: MetaGraphResponse, leadgenId: string) {
  const fields = graphData.field_data ?? [];

  const get = (...names: string[]) => {
    for (const name of names) {
      const val = fields.find((f) => f.name === name)?.values?.[0];
      if (val) return val.trim();
    }
    return '';
  };

  const phone = normalizePhone(get('phone_number', 'phone', 'mobile'));

  // Concatenate custom question answers into product_interest / notes
  const customAnswers = fields
    .filter((f) => !STANDARD_FIELDS.has(f.name) && f.values?.[0])
    .map((f) => `${f.name.replace(/_/g, ' ')}: ${f.values[0]}`)
    .join('\n');

  const productInterest = get('product_interest', 'product', 'message', 'products_interested')
    || customAnswers
    || undefined;

  const notes = toSentenceCase(
    get('message', 'requirement', 'notes') || customAnswers,
  ) || undefined;

  return {
    name:             get('full_name', 'first_name') || 'Unknown Lead',
    phone,
    email:            get('email') || undefined,
    city:             get('city', 'location') || undefined,
    source:           LeadSource.META,
    product_interest: productInterest,
    notes,
    context:          contextToLabel(LeadContext.META_LEAD_FORM),
    lead_source_label: 'meta_lead_form',
    channel:          'FORM',
    utm_source:       'meta',
    utm_campaign:     graphData.campaign_name || undefined,
    landing_page:     undefined,
    external_id:      leadgenId,
    raw_payload: {
      leadgen_id:    leadgenId,
      field_data:    fields,
      ad_name:       graphData.ad_name,
      adset_name:    graphData.adset_name,
      campaign_name: graphData.campaign_name,
    },
  };
}

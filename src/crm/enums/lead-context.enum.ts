export enum LeadContext {
  // Shopify
  SHOPIFY_WHATSAPP_CLICK  = 'SHOPIFY_WHATSAPP_CLICK',
  SHOPIFY_FLOATING_BUTTON = 'SHOPIFY_FLOATING_BUTTON',
  SHOPIFY_EXIT_POPUP      = 'SHOPIFY_EXIT_POPUP',
  SHOPIFY_PRODUCT_FORM    = 'SHOPIFY_PRODUCT_FORM',
  // Meta
  META_LEAD_FORM          = 'META_LEAD_FORM',
  // Google
  GOOGLE_ORGANIC          = 'GOOGLE_ORGANIC',
  GOOGLE_ADS              = 'GOOGLE_ADS',
  // IndiaMart
  INDIAMART_QUERY         = 'INDIAMART_QUERY',
  // WhatsApp
  WHATSAPP_INBOUND        = 'WHATSAPP_INBOUND',
  // Direct
  DIRECT_MANUAL           = 'DIRECT_MANUAL',
  DIRECT_CALL             = 'DIRECT_CALL',
}

const CONTEXT_LABELS: Record<LeadContext, string> = {
  [LeadContext.SHOPIFY_WHATSAPP_CLICK]:  'SHOPIFY – WhatsApp Click',
  [LeadContext.SHOPIFY_FLOATING_BUTTON]: 'SHOPIFY – Floating Button',
  [LeadContext.SHOPIFY_EXIT_POPUP]:      'SHOPIFY – Exit Popup',
  [LeadContext.SHOPIFY_PRODUCT_FORM]:    'SHOPIFY – Product Form',
  [LeadContext.META_LEAD_FORM]:          'META – Lead Form',
  [LeadContext.GOOGLE_ORGANIC]:          'GOOGLE – Organic',
  [LeadContext.GOOGLE_ADS]:              'GOOGLE – Ads',
  [LeadContext.INDIAMART_QUERY]:         'INDIAMART – Query',
  [LeadContext.WHATSAPP_INBOUND]:        'WHATSAPP – Inbound Message',
  [LeadContext.DIRECT_MANUAL]:           'DIRECT – Manual Entry',
  [LeadContext.DIRECT_CALL]:             'DIRECT – Inbound Call',
};

/**
 * Maps a LeadContext enum value to its human-readable "PLATFORM – SOURCE" label for DB storage.
 * Unknown/legacy values are returned as-is so existing data is never corrupted.
 */
export function contextToLabel(context: string | undefined): string {
  if (!context) return 'DIRECT – Manual Entry';
  return CONTEXT_LABELS[context as LeadContext] ?? context;
}

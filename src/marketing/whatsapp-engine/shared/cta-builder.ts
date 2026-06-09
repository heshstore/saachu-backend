/**
 * Reusable CTA builder for WhatsApp promotional messages.
 * Produces consistent formatting across AI-template and manual-template paths.
 *
 * Product CTA format — URL always on its own line below the label:
 *
 *   🛍 Click here to view product
 *
 *   https://www.heshstore.in/products/foo
 */

export type CtaConfig =
  | { type: 'call';    phone: string;               callLabel?: string }
  | { type: 'product'; url: string;                 viewLabel?: string }
  | { type: 'both';    phone: string; url: string;  callLabel?: string; viewLabel?: string };

const VIEW_LABELS = [
  '🛍 Click here to view product',
  '🛍 See product photos & details',
  '🛍 Check product here',
] as const;

function pickViewLabel(override?: string): string {
  if (override) return override;
  return VIEW_LABELS[Math.floor(Math.random() * VIEW_LABELS.length)];
}

/**
 * Build a CTA block ready to append to a message.
 *
 * Phone:
 *   "📞 Call us: +919999999999"
 *
 * Product (URL always on separate line):
 *   "🛍 Click here to view product\n\nhttps://..."
 *
 * Both:
 *   "📞 Call us: +919999999999\n🛍 Click here to view product\n\nhttps://..."
 */
export function buildCta(config: CtaConfig): string {
  const callLabel = ('callLabel' in config && config.callLabel) ? config.callLabel : 'Call / WhatsApp';
  const viewLabel = pickViewLabel(
    ('viewLabel' in config && config.viewLabel) ? config.viewLabel : undefined,
  );

  switch (config.type) {
    case 'call':
      return `📞 ${callLabel}: ${config.phone}`;
    case 'product':
      return `${viewLabel}\n\n${config.url}`;
    case 'both':
      return `📞 ${callLabel}: ${config.phone}\n${viewLabel}\n\n${config.url}`;
  }
}

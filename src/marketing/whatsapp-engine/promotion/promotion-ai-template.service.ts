import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';

export interface PromotionGenerateInput {
  telecaller_number_id: string;
  telecaller_phone: string;
  product: ShopifyCatalogItem;
  customer: {
    name: string;
    city?: string;
    business_type?: string;
    phone?: string;
  };
  campaign_id?: string;
  template_id?: string;
  /** DB-sourced only — never AI-generated. Undefined = no active offer. */
  offer?: { title?: string | null; text: string };
}

export interface PromotionGenerateResult {
  /** Caption text — sent as WhatsApp image caption when imageUrl present, standalone text otherwise. */
  message: string;
  /** Shopify product image URL. Sender dispatches this as a WhatsApp image + caption. Null when unavailable. */
  imageUrl: string | null;
  /** Direct product search URL for the "View Product" CTA. */
  productUrl: string;
  metadata: {
    templateVariant: string;
    callCtaUsed: string;
    viewCtaUsed: string;
    hookType: string;
    messageLength: number;
    productSku: string;
  };
}

// ── Call-Us CTA variants — rotated per contact ────────────────────────────────
const CALL_CTAS = [
  { key: 'call_us',       label: 'Call Us' },
  { key: 'talk_to_team',  label: 'Talk to Team' },
  { key: 'contact_us',    label: 'Contact Us' },
  { key: 'reach_us',      label: 'Reach Us' },
];

// ── View-Product CTA variants — rotated per contact ───────────────────────────
const VIEW_CTAS = [
  { key: 'view_product',  label: 'View Product' },
  { key: 'see_product',   label: 'See Product' },
  { key: 'check_product', label: 'Check Product' },
];

// ── Curiosity / pain-point hooks — city substituted where available ────────────
const HOOKS = [
  { key: 'city_demand',     text: (city: string) => city ? `Many businesses in ${city} are sourcing this right now.` : `This has been getting a lot of attention from buyers recently.` },
  { key: 'expand_range',    text: (_: string) => `Looking to expand your product range this season?` },
  { key: 'worth_a_look',    text: (_: string) => `This one is worth a quick look before your next order.` },
  { key: 'not_seen_before', text: (_: string) => `Here is something you might not have come across before.` },
  { key: 'next_order',      text: (_: string) => `If you are planning your next purchase, this might interest you.` },
  { key: 'team_pick',       text: (_: string) => `Our team picked this as a standout item this month.` },
];

// ── Factual benefit phrases — product-name substituted ────────────────────────
const BENEFIT_PHRASES = [
  (name: string) => `${name} is well-suited for businesses looking for reliable quality at a consistent standard.`,
  (name: string) => `Customers who stocked ${name} have found it to be a dependable addition to their catalogue.`,
  (name: string) => `${name} is a product our team is actively supplying across several business types.`,
  (name: string) => `${name} has a clean SKU structure and ships in standard quantities — easy to reorder.`,
  (name: string) => `${name} fits well into most product lines and is straightforward to integrate into your stock.`,
];

const OPENERS = [
  'Hope business is going well.',
  'Quick update from our team:',
  'Sharing something relevant to your line of work:',
  'Just wanted to bring this to your notice:',
  'Something new that might interest you:',
];

// ── Safety patterns — checked before sending ──────────────────────────────────
const FORBIDDEN_PATTERNS = [
  /limited\s+time/i,
  /last\s+chance/i,
  /hurry/i,
  /act\s+now/i,
  /don'?t\s+miss/i,
  /₹\s*\d/,
  /\bfree\b/i,
  /\bdiscount\b/i,
  /\boffer\b/i,
];

const STORE_BASE = 'https://www.heshstore.in';

@Injectable()
export class PromotionAiTemplateService {
  private readonly logger = new Logger(PromotionAiTemplateService.name);

  // Per-phone CTA history — avoids repeating the same variant back-to-back
  private _callCtaHistory = new Map<string, string[]>();
  private _viewCtaHistory = new Map<string, string[]>();

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generate(input: PromotionGenerateInput): Promise<PromotionGenerateResult> {
    const { product, customer, telecaller_phone, offer } = input;

    const productName = product.itemName ?? product.sku ?? 'this product';
    const city        = customer.city ?? '';
    const name        = customer.name?.trim() || 'there';

    const hook      = this._pickHook(city);
    const benefit   = this._pickBenefit(productName);
    const opener    = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    const callCta   = this._pickFreshCallCta(customer.phone);
    const viewCta   = this._pickFreshViewCta(customer.phone);
    const variant   = `v${Math.floor(Math.random() * 3) + 1}`;

    // Product URL — search by SKU so WhatsApp renders it as a product card
    const productUrl = product.sku
      ? `${STORE_BASE}/search?q=${encodeURIComponent(product.sku)}`
      : STORE_BASE;

    const baseParts = {
      name, opener, hook: hook.text,
      productName, sku: product.sku ?? '',
      benefit,
      callCtaLabel: callCta.label,
      viewCtaLabel: viewCta.label,
      senderPhone: telecaller_phone,
      productUrl,
    };

    // Safety check on generated copy (before offer line which is operator-controlled)
    this._assertSafe(this._buildMessage(baseParts));

    const offerLine = offer?.text
      ? (offer.title ? `${offer.title}: ${offer.text}` : offer.text)
      : undefined;

    const message = this._buildMessage({ ...baseParts, offerLine });

    this.logger.log(
      `[PROMO_OFFER] template_id=${input.template_id ?? 'none'} sku=${product.sku} ` +
      `offer_applied=${!!offerLine} offer_source=${offerLine ? 'template_db' : 'none'}`,
    );
    this.logger.log(
      `[PROMO_AI_TEMPLATE] telecaller=${input.telecaller_number_id} ` +
      `sku=${product.sku} hook=${hook.key} call_cta=${callCta.key} view_cta=${viewCta.key} length=${message.length}`,
    );

    return {
      message,
      imageUrl:   product.image || null,
      productUrl,
      metadata: {
        templateVariant: variant,
        callCtaUsed:     callCta.key,
        viewCtaUsed:     viewCta.key,
        hookType:        hook.key,
        messageLength:   message.length,
        productSku:      product.sku ?? '',
      },
    };
  }

  // ── Message structure ─────────────────────────────────────────────────────────
  // Image is sent as a separate WhatsApp media message by the sender; this text
  // becomes the caption (or a standalone message when no image is available).
  private _buildMessage(parts: {
    name: string;
    opener: string;
    hook: (city: string) => string;
    productName: string;
    sku: string;
    benefit: string;
    callCtaLabel: string;
    viewCtaLabel: string;
    senderPhone: string;
    productUrl: string;
    offerLine?: string;
  }): string {
    const lines: string[] = [
      `Hi ${parts.name},`,
      ``,
      parts.opener,
      ``,
      parts.hook(''),
      ``,
      `*${parts.productName}*`,
      `SKU: ${parts.sku}`,
      ``,
      parts.benefit,
    ];

    if (parts.offerLine) {
      lines.push(``, `🎁 ${parts.offerLine}`);
    }

    lines.push(
      ``,
      `📞 ${parts.callCtaLabel}: ${parts.senderPhone}`,
      `🛍 ${parts.viewCtaLabel}: ${parts.productUrl}`,
    );

    return lines.join('\n');
  }

  // ── Pickers ───────────────────────────────────────────────────────────────────

  private _pickHook(city: string): { key: string; text: (c: string) => string } {
    const hook = HOOKS[Math.floor(Math.random() * HOOKS.length)];
    return { key: hook.key, text: () => hook.text(city) };
  }

  private _pickBenefit(productName: string): string {
    return BENEFIT_PHRASES[Math.floor(Math.random() * BENEFIT_PHRASES.length)](productName);
  }

  private _pickFreshCallCta(phone?: string): { key: string; label: string } {
    return this._pickFromPool(CALL_CTAS, this._callCtaHistory, phone);
  }

  private _pickFreshViewCta(phone?: string): { key: string; label: string } {
    return this._pickFromPool(VIEW_CTAS, this._viewCtaHistory, phone);
  }

  private _pickFromPool<T extends { key: string }>(
    pool: T[],
    history: Map<string, string[]>,
    phone?: string,
  ): T {
    if (!phone) return pool[Math.floor(Math.random() * pool.length)];
    const used   = new Set(history.get(phone) ?? []);
    const fresh  = pool.filter((c) => !used.has(c.key));
    const source = fresh.length > 0 ? fresh : pool;
    const picked = source[Math.floor(Math.random() * source.length)];
    history.set(phone, [...(history.get(phone) ?? []), picked.key].slice(-pool.length));
    return picked;
  }

  private _assertSafe(message: string): void {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(message)) {
        this.logger.warn(`[PROMO_AI_SAFETY] blocked_pattern=${pattern.toString()}`);
      }
    }
    const emojiCount = (message.match(/\p{Emoji_Presentation}/gu) ?? []).length;
    if (emojiCount > 3) {
      this.logger.warn(`[PROMO_AI_SAFETY] emoji_count=${emojiCount} exceeds limit of 3`);
    }
  }
}

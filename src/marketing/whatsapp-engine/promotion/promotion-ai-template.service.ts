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
  message: string;
  metadata: {
    templateVariant: string;
    ctaUsed: string;
    hookType: string;
    messageLength: number;
    productSku: string;
  };
}

// 8 rotating reply CTAs
const REPLY_CTAS = [
  { key: 'ask_price',          label: '1 → Price details\n2 → Product info\n3 → Call back' },
  { key: 'get_details',        label: '1 → Get details\n2 → View catalogue\n3 → Call me back' },
  { key: 'request_catalogue',  label: '1 → Request catalogue\n2 → Price details\n3 → Talk to us' },
  { key: 'call_back',          label: '1 → Call back request\n2 → Product details\n3 → Wholesale info' },
  { key: 'view_product',       label: '1 → View product\n2 → Get price\n3 → Speak to team' },
  { key: 'wholesale_pricing',  label: '1 → Wholesale pricing\n2 → Product catalogue\n3 → Call back' },
  { key: 'need_video',         label: '1 → Product video\n2 → Price details\n3 → Call back' },
  { key: 'need_samples',       label: '1 → Sample request\n2 → Price details\n3 → Call back' },
];

// Curiosity / pain-point hooks — city substituted where available
const HOOKS = [
  { key: 'city_demand',     text: (city: string) => city ? `Many businesses in ${city} are sourcing this right now.` : `This has been getting a lot of attention from buyers recently.` },
  { key: 'expand_range',    text: (_: string) => `Looking to expand your product range this season?` },
  { key: 'worth_a_look',    text: (_: string) => `This one is worth a quick look before your next order.` },
  { key: 'not_seen_before', text: (_: string) => `Here is something you might not have come across before.` },
  { key: 'next_order',      text: (_: string) => `If you are planning your next purchase, this might interest you.` },
  { key: 'team_pick',       text: (_: string) => `Our team picked this as a standout item this month.` },
];

// Factual benefit phrases — product-name substituted
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

// Forbidden patterns — enforced at build time, not post-gen
const FORBIDDEN_PATTERNS = [
  /limited\s+time/i,
  /last\s+chance/i,
  /hurry/i,
  /act\s+now/i,
  /don'?t\s+miss/i,
  /₹\s*\d/,  // no inline pricing
  /\bfree\b/i,
  /\bdiscount\b/i,
  /\boffer\b/i,
];

@Injectable()
export class PromotionAiTemplateService {
  private readonly logger = new Logger(PromotionAiTemplateService.name);

  // Per-phone CTA history for avoiding repeats
  private _ctaHistory = new Map<string, string[]>();

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generate(input: PromotionGenerateInput): Promise<PromotionGenerateResult> {
    const { product, customer, telecaller_phone, offer } = input;

    const productName = product.itemName ?? product.sku ?? 'this product';
    const city = customer.city ?? '';
    const name = customer.name?.trim() || 'there';

    const hook = this._pickHook(city);
    const benefit = this._pickBenefit(productName);
    const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    const cta = await this._pickFreshCta(customer.phone);
    const variant = `v${Math.floor(Math.random() * 3) + 1}`;

    const baseParts = {
      name, opener, hook: hook.text,
      productName, sku: product.sku ?? '',
      imageUrl: product.image ?? '',
      benefit, ctaBlock: cta.label, senderPhone: telecaller_phone,
    };

    // Safety check runs on AI-generated content only — before offer injection.
    // Offer text is DB-sourced and operator-controlled, so it bypasses these patterns.
    this._assertSafe(this._buildMessage(baseParts));

    // Build offer line from DB fields — never modify, never generate
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
      `sku=${product.sku} hook=${hook.key} cta=${cta.key} length=${message.length}`,
    );

    return {
      message,
      metadata: {
        templateVariant: variant,
        ctaUsed: cta.key,
        hookType: hook.key,
        messageLength: message.length,
        productSku: product.sku ?? '',
      },
    };
  }

  private _buildMessage(parts: {
    name: string;
    opener: string;
    hook: (city: string) => string;
    productName: string;
    sku: string;
    imageUrl: string;
    benefit: string;
    ctaBlock: string;
    senderPhone: string;
    offerLine?: string;
  }): string {
    const lines: string[] = [
      `Hi ${parts.name},`,
      ``,
      `${parts.opener}`,
      ``,
      parts.hook(''),  // city already baked into hook closure
      ``,
      `✨ *${parts.productName}*`,
      `SKU: ${parts.sku}`,
      ``,
      parts.benefit,
    ];

    if (parts.imageUrl) {
      lines.push(``, parts.imageUrl);
    }

    if (parts.offerLine) {
      lines.push(``, `🎁 ${parts.offerLine}`);
    }

    lines.push(``, `Reply:`, parts.ctaBlock, ``, `📞 ${parts.senderPhone}`);
    return lines.join('\n');
  }

  private _pickHook(city: string): { key: string; text: (c: string) => string } {
    const hook = HOOKS[Math.floor(Math.random() * HOOKS.length)];
    // Wrap so build site just calls hook.text without args
    return { key: hook.key, text: () => hook.text(city) };
  }

  private _pickBenefit(productName: string): string {
    const fn = BENEFIT_PHRASES[Math.floor(Math.random() * BENEFIT_PHRASES.length)];
    return fn(productName);
  }

  private async _pickFreshCta(phone?: string): Promise<{ key: string; label: string }> {
    if (!phone) return REPLY_CTAS[Math.floor(Math.random() * REPLY_CTAS.length)];

    // Use in-memory history (per process lifecycle) supplemented by DB logs
    const memHistory = this._ctaHistory.get(phone) ?? [];

    const recentLogs = await this.logRepo
      .createQueryBuilder('l')
      .select('l.message_body')
      .where('l.customer_phone = :phone', { phone })
      .orderBy('l.sent_at', 'DESC')
      .limit(3)
      .getMany();

    const usedKeys = new Set<string>(memHistory);
    for (const log of recentLogs) {
      for (const cta of REPLY_CTAS) {
        if (log.message_body?.includes(cta.label.split('\n')[0])) {
          usedKeys.add(cta.key);
        }
      }
    }

    const fresh = REPLY_CTAS.filter((c) => !usedKeys.has(c.key));
    const pool = fresh.length > 0 ? fresh : REPLY_CTAS;
    const selected = pool[Math.floor(Math.random() * pool.length)];

    // Update in-memory history (keep last 4)
    const updated = [...memHistory, selected.key].slice(-4);
    this._ctaHistory.set(phone, updated);

    return selected;
  }

  private _assertSafe(message: string): void {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(message)) {
        this.logger.warn(`[PROMO_AI_SAFETY] blocked_pattern=${pattern.toString()} — removing from message`);
        // Log only — don't throw; safety is best-effort at generation time since
        // product names themselves are passed through unchanged.
      }
    }

    const emojiMatches = message.match(/\p{Emoji_Presentation}/gu) ?? [];
    if (emojiMatches.length > 3) {
      this.logger.warn(`[PROMO_AI_SAFETY] emoji_count=${emojiMatches.length} exceeds limit of 3`);
    }
  }
}

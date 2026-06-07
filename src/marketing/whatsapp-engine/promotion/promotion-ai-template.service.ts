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
  /** Product search URL — stored in message_payload for analytics; NOT included in message text. */
  productUrl: string;
  metadata: {
    templateVariant: string;
    contentCategory: ContentCategory;
    softCtaUsed: string;
    hookType: string;
    messageLength: number;
    productSku: string;
  };
}

// ── Content category type ─────────────────────────────────────────────────────
type ContentCategory =
  | 'knowledge'
  | 'product_info'
  | 'benefit'
  | 'problem_sol'
  | 'social_proof'
  | 'direct_promo';

// Cumulative probability thresholds (weights: 40/25/20/10/3/2)
const CATEGORY_THRESHOLDS: [ContentCategory, number][] = [
  ['knowledge',    40],
  ['product_info', 65],
  ['benefit',      85],
  ['problem_sol',  95],
  ['social_proof', 98],
  ['direct_promo', 100],
];

// ── Knowledge content ─────────────────────────────────────────────────────────
// Industry insights first; product mentioned as supporting element, not subject.
const KNOWLEDGE_BLOCKS = [
  {
    insight: (city: string) => city
      ? `One thing we see in well-run showrooms across ${city} — products placed at eye level with clear spacing tend to attract more attention from buyers than crowded or disorganized displays.`
      : `A consistent pattern in well-run showrooms — products with clear spacing and good visibility tend to attract more buyer attention than overcrowded displays.`,
    connection: (n: string) => `${n} fits this kind of organized layout well.`,
    outcome: `It keeps individual products visible without overcrowding the display area.`,
  },
  {
    insight: (_: string) => `For B2B buyers, how a product range is displayed often determines how quickly they shortlist items. Clear grouping and labeling reduce the time between entry and enquiry.`,
    connection: (n: string) => `${n} works well in setups built around that kind of clarity.`,
    outcome: `Buyers can locate and identify items faster, which usually leads to quicker decision-making.`,
  },
  {
    insight: (city: string) => city
      ? `Something worth thinking about for showrooms in ${city} — consistency in how products are displayed across the floor tends to improve the overall impression for visiting buyers.`
      : `Consistency in how products are displayed tends to improve the overall impression for visiting buyers.`,
    connection: (n: string) => `${n} is a straightforward option that supports that kind of consistent presentation.`,
    outcome: `It avoids the visual inconsistency that comes from mixing different display formats.`,
  },
  {
    insight: (_: string) => `Display density is something most businesses underestimate. Too crowded and products get overlooked. Too sparse and the range looks thin. The right balance tends to keep buyers engaged longer.`,
    connection: (n: string) => `${n} is designed with that balance in mind.`,
    outcome: `It keeps the display full enough to look complete without making it hard to navigate.`,
  },
  {
    insight: (city: string) => city
      ? `Businesses in ${city} that rotate their display focus seasonally tend to generate more enquiries on featured products than those with a static layout throughout the year.`
      : `Businesses that rotate their display focus seasonally tend to generate more enquiries on featured products than those with a static layout.`,
    connection: (n: string) => `${n} works well as a featured item in this kind of rotation.`,
    outcome: `It has a clean presentation that holds attention when placed in a prominent display position.`,
  },
  {
    insight: (_: string) => `Keeping a large SKU range organized is one of the ongoing challenges for product showrooms. When items are not easy to locate, buyers tend to miss products they would have considered.`,
    connection: (n: string) => `${n} is useful for this kind of organized setup — it maintains individual product visibility even in a dense range.`,
    outcome: `Buyers can scan the range and identify items without needing staff assistance for each one.`,
  },
  {
    insight: (_: string) => `Something we hear often from showrooms — the initial display setup gets maintained well, but over time it drifts as products get restocked inconsistently. Systems that are easy to reset tend to hold their structure longer.`,
    connection: (n: string) => `${n} is built to maintain its position without constant adjustment.`,
    outcome: `That kind of stability reduces the maintenance effort while keeping the display consistent.`,
  },
  {
    insight: (_: string) => `For businesses managing product lines across multiple showroom locations, maintaining a consistent display standard is often harder than setting one up in the first place. Standardized components make that significantly easier.`,
    connection: (n: string) => `${n} is a standardized component that works across different showroom configurations.`,
    outcome: `Using the same format across locations makes training and maintenance much more straightforward.`,
  },
] as const;

// ── Product info content ──────────────────────────────────────────────────────
// Product is the main subject. Explains what it is and where it fits.
const PRODUCT_INFO_BLOCKS = [
  {
    opener: (_: string) => `Wanted to share something about a product from our catalog.`,
    explain: (n: string, sku: string) => `${n} — SKU ${sku} — is designed for display applications where clean organization and individual product visibility are priorities.`,
    application: `It fits standard configurations without needing customization and maintains its structure under regular use.`,
  },
  {
    opener: (_: string) => `Quick note on something relevant from our range.`,
    explain: (n: string, sku: string) => `${n} (SKU: ${sku}) is a display component used for organizing product ranges in showroom and retail environments.`,
    application: `The construction is straightforward and it integrates with most standard shelving or display systems.`,
  },
  {
    opener: (name: string) => `${name}, sharing something from our catalog that might be relevant to your setup.`,
    explain: (n: string, sku: string) => `${n} — SKU ${sku}. It is a display item built for businesses that want to present a product range clearly without complex installation.`,
    application: `Works well as a standalone display or alongside other catalog items in a larger showroom layout.`,
  },
  {
    opener: (_: string) => `Thought this might be worth bringing to your notice.`,
    explain: (n: string, sku: string) => `${n} (${sku}) is part of our core display range. It is a practical option for businesses that want consistent product presentation across their showroom.`,
    application: `The design keeps individual products visible and accessible without requiring frequent adjustment.`,
  },
  {
    opener: (_: string) => `Something from our product range that seems relevant to your type of business.`,
    explain: (n: string, sku: string) => `${n} — SKU ${sku}. Typically used when a business wants to display a range of items cleanly without the clutter that comes from stacking or overcrowding.`,
    application: `It keeps items individually accessible, which works better for businesses where buyers browse before deciding.`,
  },
] as const;

// ── Benefit content ───────────────────────────────────────────────────────────
// How the customer benefits — practical, operational, buyer-experience focused.
const BENEFIT_BLOCKS = [
  {
    hook: (city: string) => city
      ? `Something that tends to make a practical difference in showrooms in ${city}.`
      : `Something that tends to make a practical difference in product showroom setups.`,
    product_use: (n: string) => `${n} is used to improve how a product range is displayed — keeping items individually visible and easy to browse.`,
    benefit: `This reduces the time buyers spend searching for specific items and generally shortens the path to an enquiry.`,
  },
  {
    hook: (_: string) => `If keeping your display organized through busy periods is a priority, this might be useful.`,
    product_use: (n: string) => `${n} is designed to maintain its position and structure even with regular restocking and heavy use.`,
    benefit: `That kind of stability means less time spent resetting the display and more consistency for visiting buyers.`,
  },
  {
    hook: (_: string) => `A simple improvement that tends to have a visible impact on how buyers engage with a product range.`,
    product_use: (n: string) => `${n} gives each product in the range its own visible position — avoiding the grouping that makes individual items hard to notice.`,
    benefit: `Buyers tend to spend more time browsing when products are clearly separated and easy to identify.`,
  },
  {
    hook: (city: string) => city
      ? `For businesses in ${city} managing a large product range, visibility is usually the first challenge.`
      : `For businesses managing a large product range, visibility is often the first challenge.`,
    product_use: (n: string) => `${n} helps address this directly — it keeps individual products visible even when the overall range is extensive.`,
    benefit: `Buyers can scan and shortlist faster, which tends to lead to more enquiries per visit.`,
  },
  {
    hook: (_: string) => `One area where small changes tend to have a noticeable impact — how easy products are to locate in the display.`,
    product_use: (n: string) => `${n} is built for exactly this. It gives each item a consistent, fixed position in the display layout.`,
    benefit: `This makes it easier for staff to point buyers to specific products and for buyers to return to items they were considering.`,
  },
] as const;

// ── Problem → Solution content ────────────────────────────────────────────────
// Present a recognizable industry problem, then show product as the solution.
const PROBLEM_SOL_BLOCKS = [
  {
    problem: `Products stacked behind each other become difficult to browse, especially when the range is large. Buyers tend to skip past items they cannot clearly see.`,
    solution: (n: string) => `${n} addresses this by keeping each product individually visible and accessible.`,
    outcome: `This tends to improve the number of products buyers engage with during a single visit.`,
  },
  {
    problem: `Display units that shift or tip under product weight are a common issue in showrooms. They create a poor impression and require ongoing attention from staff.`,
    solution: (n: string) => `${n} is built to stay in position under regular use.`,
    outcome: `That stability reduces maintenance time and keeps the showroom looking organized without constant adjustment.`,
  },
  {
    problem: `When a product range grows, it often becomes harder to display everything clearly. Items get grouped in ways that reduce individual visibility and make browsing harder.`,
    solution: (n: string) => `${n} is designed to scale with the range — it keeps individual products visible even in a larger display setup.`,
    outcome: `Buyers can navigate a wider range without it feeling overwhelming or hard to browse.`,
  },
  {
    problem: `Inconsistent display standards across showroom branches tend to create confusion for buyers who visit multiple locations.`,
    solution: (n: string) => `${n} provides a standardized display component that can be replicated across locations without customization.`,
    outcome: `This makes it easier to maintain a consistent presentation standard regardless of which branch a buyer visits.`,
  },
  {
    problem: `Busy periods in a showroom often leave displays looking disorganized by mid-day. Resetting takes time that staff do not always have.`,
    solution: (n: string) => `${n} holds its structure after restocking, so the display stays organized with less intervention.`,
    outcome: `This reduces the reset effort and keeps the presentation consistent throughout the day.`,
  },
] as const;

// ── Social proof content (3%) ─────────────────────────────────────────────────
// Trust signals — minimal, factual, no superlatives.
const SOCIAL_PROOF_BLOCKS = [
  {
    hook: `This is a configuration that a number of businesses in this category have found useful for their showroom setup.`,
    brief: (n: string, sku: string) => `${n} — SKU ${sku}.`,
    note: `It is a commonly used option for businesses that want a clean, organized display without a heavy investment in custom fittings.`,
  },
  {
    hook: `A number of buyers we work with have used this as part of their display reorganization.`,
    brief: (n: string, sku: string) => `${n} (SKU: ${sku}).`,
    note: `It tends to be a practical choice for businesses that want a reliable display format that holds its structure over time.`,
  },
  {
    hook: `This is one of the more frequently chosen options in its category from our catalog.`,
    brief: (n: string, sku: string) => `${n} — SKU ${sku}.`,
    note: `Businesses typically choose it when they want a consistent, easy-to-maintain display that works across different product types.`,
  },
] as const;

// ── Direct promo content (2%) ─────────────────────────────────────────────────
// Short, factual, no urgency language.
const DIRECT_PROMO_BLOCKS = [
  {
    intro: `A quick note on something from our catalog that might interest you.`,
    detail: (n: string, sku: string) => `${n} — SKU ${sku}. It is a display item we currently have in stock, designed for product showroom applications.`,
  },
  {
    intro: `Sharing something relevant from our range.`,
    detail: (n: string, sku: string) => `${n} (${sku}). A display component suited for businesses looking to organize and present their product range cleanly.`,
  },
] as const;

// ── Soft CTAs ─────────────────────────────────────────────────────────────────
// Goal: invite a reply, not a click. Customer must reply to receive more.
const SOFT_CTAS = [
  'Can share dimensions or specifications if useful for your setup.',
  'Happy to send across a catalog if you would like to browse the range.',
  'Let me know if this is relevant — can share more details.',
  'Can share specifications or a product sheet if needed.',
  'Happy to share more if this fits what you are currently looking for.',
  'Let me know if useful — can follow up with details.',
  'Can send across more product information if this is relevant to your requirements.',
  'Happy to share dimensions and availability if this looks like a fit.',
];

// ── Safety patterns ───────────────────────────────────────────────────────────
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

  // Per-phone soft CTA history — avoids repeating the same variant back-to-back
  private _softCtaHistory = new Map<string, string[]>();

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generate(input: PromotionGenerateInput): Promise<PromotionGenerateResult> {
    const { product, customer, offer } = input;

    const productName = product.itemName ?? product.sku ?? 'this product';
    const city        = customer.city ?? '';
    const name        = customer.name?.trim() || 'there';
    const sku         = product.sku ?? '';

    const category = this._pickCategory();
    const softCta  = this._pickSoftCta(customer.phone);

    const productUrl = sku
      ? `${STORE_BASE}/search?q=${encodeURIComponent(sku)}`
      : STORE_BASE;

    const message = this._buildMessage({ name, productName, sku, city, category, softCta, offer });

    this._assertSafe(message);

    this.logger.log(
      `[PROMO_AI] category=${category} sku=${sku} ` +
      `offer=${!!offer?.text} customer=${customer.phone} length=${message.length}`,
    );

    return {
      message,
      imageUrl:   product.image || null,
      productUrl,
      metadata: {
        templateVariant: `v${Math.floor(Math.random() * 3) + 1}`,
        contentCategory: category,
        softCtaUsed:     softCta.slice(0, 60),
        hookType:        category,
        messageLength:   message.length,
        productSku:      sku,
      },
    };
  }

  // ── Category selection ────────────────────────────────────────────────────────

  private _pickCategory(): ContentCategory {
    const r = Math.random() * 100;
    for (const [cat, threshold] of CATEGORY_THRESHOLDS) {
      if (r < threshold) return cat;
    }
    return 'direct_promo';
  }

  // ── Message assembly ──────────────────────────────────────────────────────────

  private _buildMessage(parts: {
    name: string;
    productName: string;
    sku: string;
    city: string;
    category: ContentCategory;
    softCta: string;
    offer?: { title?: string | null; text: string };
  }): string {
    const { name, productName, sku, city, category, softCta, offer } = parts;
    const lines: string[] = [`Hi ${name},`, ``];

    switch (category) {
      case 'knowledge': {
        const b = this._pickRandom([...KNOWLEDGE_BLOCKS]);
        lines.push(b.insight(city), ``, b.connection(productName), ``, b.outcome);
        break;
      }
      case 'product_info': {
        const b = this._pickRandom([...PRODUCT_INFO_BLOCKS]);
        lines.push(b.opener(name), ``, b.explain(productName, sku), ``, b.application);
        break;
      }
      case 'benefit': {
        const b = this._pickRandom([...BENEFIT_BLOCKS]);
        lines.push(b.hook(city), ``, b.product_use(productName), ``, b.benefit);
        break;
      }
      case 'problem_sol': {
        const b = this._pickRandom([...PROBLEM_SOL_BLOCKS]);
        lines.push(b.problem, ``, b.solution(productName), ``, b.outcome);
        break;
      }
      case 'social_proof': {
        const b = this._pickRandom([...SOCIAL_PROOF_BLOCKS]);
        lines.push(b.hook, ``, b.brief(productName, sku), ``, b.note);
        break;
      }
      case 'direct_promo': {
        const b = this._pickRandom([...DIRECT_PROMO_BLOCKS]);
        lines.push(b.intro, ``, b.detail(productName, sku));
        break;
      }
    }

    if (offer?.text) {
      const offerLine = offer.title ? `${offer.title}: ${offer.text}` : offer.text;
      lines.push(``, offerLine);
    }

    lines.push(``, softCta);

    return lines.join('\n');
  }

  // ── Pickers ───────────────────────────────────────────────────────────────────

  private _pickSoftCta(phone?: string): string {
    return this._pickFromPool(SOFT_CTAS, this._softCtaHistory, phone);
  }

  private _pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private _pickFromPool<T extends string>(
    pool: readonly T[],
    history: Map<string, string[]>,
    phone?: string,
  ): T {
    if (!phone) return this._pickRandom([...pool]);
    const used   = new Set(history.get(phone) ?? []);
    const fresh  = pool.filter((c) => !used.has(c));
    const source = fresh.length > 0 ? fresh : [...pool];
    const picked = this._pickRandom(source) as T;
    history.set(phone, [...(history.get(phone) ?? []), picked].slice(-pool.length));
    return picked;
  }

  private _assertSafe(message: string): void {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(message)) {
        this.logger.warn(`[PROMO_AI_SAFETY] blocked_pattern=${pattern.toString()}`);
      }
    }
    const emojiCount = (message.match(/\p{Emoji_Presentation}/gu) ?? []).length;
    if (emojiCount > 2) {
      this.logger.warn(`[PROMO_AI_SAFETY] emoji_count=${emojiCount} exceeds limit of 2`);
    }
  }
}

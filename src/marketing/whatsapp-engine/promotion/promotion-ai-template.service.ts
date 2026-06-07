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
  /** Product page URL — stored in message_payload for analytics; also included as View Product CTA. */
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

// ── Greeting rotation ─────────────────────────────────────────────────────────
const GREETINGS: ((name: string) => string)[] = [
  (n) => `Hi ${n},`,
  (n) => `Hello ${n},`,
  (n) => `Hi ${n}.`,
  (n) => `Hello ${n}.`,
];

// ── Call CTA label rotation ───────────────────────────────────────────────────
const CALL_LABELS = ['Call us', 'Reach us', 'Contact us', 'Talk to us'];

// ── Soft CTAs — invite a reply, not a click ───────────────────────────────────
const SOFT_CTAS = [
  'Can share dimensions if useful.',
  'Happy to share more details if required.',
  'Can share additional options if you are exploring similar products.',
  'Can send specifications if needed.',
  'Can share catalog if useful.',
  'Happy to share product details if this is relevant to your setup.',
  'Can share more if you are looking at this category.',
  'Let me know — happy to share specifications.',
];

// ── KNOWLEDGE hooks (40%) ─────────────────────────────────────────────────────
// 1-2 short sentences. Industry insight, no product mention yet.
const K_HOOKS: ((city: string) => string)[] = [
  (city) => city
    ? `Many showrooms in ${city} lose browsing time when displays get overcrowded.`
    : `Many showrooms lose browsing time when displays get overcrowded.`,
  (_) => `When buyers can't find what they want quickly, they tend to move on.`,
  (_) => `Display organization directly affects how long buyers stay and what they enquire about.`,
  (_) => `Buyers shortlist faster when products are clearly spaced and easy to scan.`,
  (city) => city
    ? `B2B buyers in ${city} usually have limited time. How products are displayed affects whether they enquire.`
    : `B2B buyers usually have limited time. How products are displayed affects whether they enquire.`,
  (_) => `Showrooms that rotate featured products tend to get more enquiries on new arrivals.`,
  (_) => `When a range grows without a system, buyers start missing products they would have considered.`,
  (city) => city
    ? `Inconsistent display layouts in ${city} showrooms tend to slow down buyer decisions.`
    : `Inconsistent display layouts tend to slow down buyer decisions.`,
];

// Explain lines come AFTER the bold product header — implicit subject is the product.
const K_EXPLAINS: string[] = [
  `Helps keep products clearly visible without taking up unnecessary space.`,
  `Built for organized, easy-to-navigate layouts.`,
  `Gives each product a clear position — easy to spot, easy to reach.`,
  `Works well in structured layouts. Consistent and low-maintenance.`,
  `Helps maintain organized displays even through busy periods.`,
  `Designed for setups where clear product visibility is the priority.`,
];

const K_BENEFITS: string[] = [
  `Buyers browse faster. Enquiries usually follow.`,
  `Fewer missed products. More enquiries per visit.`,
  `Easier browsing leads to quicker buyer decisions.`,
  `Organized layouts reduce browsing time and increase what buyers notice.`,
  `When each product is visible, buyers can shortlist without needing staff help each time.`,
];

// ── PRODUCT_INFO hooks (25%) ──────────────────────────────────────────────────
const PI_HOOKS: string[] = [
  `Sharing something from our catalog that might be relevant.`,
  `Quick note on a display item from our range.`,
  `One of our catalog items that tends to fit businesses like yours.`,
  `Something worth knowing about from our display range.`,
  `A product from our catalog that might be useful to have on your radar.`,
];

// After product header — no product name repeated.
const PI_EXPLAINS: string[] = [
  `A display component for showroom and retail environments.\nFits standard configurations. No custom installation needed.`,
  `Designed for clear product organization in showroom layouts.\nHolds structure under regular use.`,
  `Keeps individual products visible and accessible.\nWorks standalone or as part of a larger layout.`,
  `Built for consistent product presentation across the display area.\nStraightforward to set up and easy to maintain.`,
  `Used for organized display in showroom and retail setups.\nNo specialized fitting required.`,
];

const PI_BENEFITS: string[] = [
  `No complex installation. Integrates with most standard shelving.`,
  `Maintains display structure without frequent adjustment.`,
  `Clean results. Low ongoing maintenance.`,
  `Practical setup. Works across different showroom sizes.`,
];

// ── BENEFIT hooks (20%) ───────────────────────────────────────────────────────
const B_HOOKS: ((city: string) => string)[] = [
  (_) => `One thing that consistently makes a difference in product showrooms.`,
  (_) => `Buyer experience often comes down to how easy products are to find.`,
  (_) => `When buyers can browse without asking for help, enquiry rates tend to improve.`,
  (city) => city
    ? `For businesses in ${city} managing a wide range — visibility is usually the first challenge.`
    : `For businesses managing a wide product range — visibility is usually the first challenge.`,
  (_) => `Clear product visibility has a direct effect on how many items buyers engage with.`,
];

const B_EXPLAINS: string[] = [
  `Helps with exactly this. Each item gets a clear, fixed position in the layout.`,
  `Keeps the display organized without taking up excess space.`,
  `Gives every product its own visible spot — easy to browse, easy to find again.`,
  `Maintains clear visibility even when the range is large.`,
];

const B_BENEFITS: string[] = [
  `Less time searching. More time enquiring.`,
  `Fewer missed products. More enquiries per visit.`,
  `Cleaner display. Faster buyer decisions.`,
  `Staff spend less time directing buyers. More time for actual conversations.`,
  `Organized layouts reduce browsing time and increase what buyers notice.`,
];

// ── PROBLEM_SOL blocks (10%) ──────────────────────────────────────────────────
// problem = hook text. solution and outcome come after the product header.
const PS_BLOCKS: { problem: string; solution: string; outcome: string }[] = [
  {
    problem: `Products stacked behind each other are hard to browse.\nBuyers skip past items they can't clearly see.`,
    solution: `Keeps each product individually visible and easy to access.`,
    outcome: `Buyers engage with more products during the same visit.`,
  },
  {
    problem: `Display units that shift under weight create a poor impression.\nThey also take up staff time to reset.`,
    solution: `Built to hold its position under regular use.`,
    outcome: `Less maintenance. Consistent presentation throughout the day.`,
  },
  {
    problem: `As ranges grow, displays become harder to navigate.\nBuyers often miss products they would have considered.`,
    solution: `Scales with the range. Each product stays visible even in a dense layout.`,
    outcome: `Wider range. Same clarity.`,
  },
  {
    problem: `Inconsistent displays across branches confuse buyers who visit multiple locations.`,
    solution: `A standardized component that replicates across different showroom setups without customization.`,
    outcome: `Same presentation standard across locations. Easier to manage.`,
  },
  {
    problem: `Busy periods leave displays disorganized by mid-day.\nResetting takes time staff don't always have.`,
    solution: `Holds its layout after restocking without constant readjustment.`,
    outcome: `Display stays organized through the day with less intervention.`,
  },
];

// ── SOCIAL_PROOF blocks (3%) ──────────────────────────────────────────────────
const SP_BLOCKS: { hook: string; note: string; benefit: string }[] = [
  {
    hook: `A number of businesses in this segment use this for their showroom display.`,
    note: `Commonly chosen for organized, easy-to-maintain displays without heavy custom fitting.`,
    benefit: `Practical and straightforward across different showroom sizes.`,
  },
  {
    hook: `This is a frequently chosen option among buyers managing a wide product range.`,
    note: `Often used when businesses want consistent display structure without complex installation.`,
    benefit: `Holds its layout well over time. Minimal maintenance required.`,
  },
  {
    hook: `One of our more regularly requested display items in this category.`,
    note: `Preferred by businesses that want clean, organized displays across a wide range.`,
    benefit: `Easy to use. Consistent results. Low ongoing effort.`,
  },
];

// ── DIRECT_PROMO blocks (2%) ──────────────────────────────────────────────────
const DP_BLOCKS: { hook: string; detail: string; benefit: string }[] = [
  {
    hook: `Sharing something from our catalog — might be relevant.`,
    detail: `A display item for organized product presentation. In stock.`,
    benefit: `Fits standard configurations. No custom installation required.`,
  },
  {
    hook: `Quick note on something from our range.`,
    detail: `A display component for showroom and retail setups. Straightforward to set up.`,
    benefit: `Keeps products organized and individually visible. Low ongoing maintenance.`,
  },
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
  private _softCtaHistory = new Map<string, string[]>();

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generate(input: PromotionGenerateInput): Promise<PromotionGenerateResult> {
    const { product, customer, telecaller_phone, offer } = input;

    const productName = product.itemName ?? product.sku ?? 'this product';
    const city        = customer.city ?? '';
    const name        = customer.name?.trim() || 'there';
    const sku         = product.sku ?? '';

    const category  = this._pickCategory();
    const greeting  = this._pickRandom(GREETINGS)(name);
    const softCta   = this._pickSoftCta(customer.phone);
    const callLabel = this._pickRandom(CALL_LABELS);
    const productUrl = this._buildProductUrl(product);

    const { hook, explain, benefit } = this._categoryContent(category, city);

    const offerLine = offer?.text
      ? (offer.title ? `${offer.title}: ${offer.text}` : offer.text)
      : undefined;

    const message = this._buildMessage({
      greeting, productName, sku, hook, explain, benefit,
      softCta, callLabel, telecallerPhone: telecaller_phone, productUrl, offerLine,
    });

    this._assertSafe(message);

    this.logger.log(
      `[PROMO_AI] category=${category} sku=${sku} ` +
      `offer=${!!offerLine} customer=${customer.phone} length=${message.length}`,
    );

    return {
      message,
      imageUrl:   product.image || null,
      productUrl,
      metadata: {
        templateVariant: `v${Math.floor(Math.random() * 3) + 1}`,
        contentCategory: category,
        softCtaUsed:     softCta,
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

  // ── Category content picker ───────────────────────────────────────────────────

  private _categoryContent(
    category: ContentCategory,
    city: string,
  ): { hook: string; explain: string; benefit: string } {
    switch (category) {
      case 'knowledge':
        return {
          hook:    this._pickRandom(K_HOOKS)(city),
          explain: this._pickRandom(K_EXPLAINS),
          benefit: this._pickRandom(K_BENEFITS),
        };
      case 'product_info':
        return {
          hook:    this._pickRandom(PI_HOOKS),
          explain: this._pickRandom(PI_EXPLAINS),
          benefit: this._pickRandom(PI_BENEFITS),
        };
      case 'benefit':
        return {
          hook:    this._pickRandom(B_HOOKS)(city),
          explain: this._pickRandom(B_EXPLAINS),
          benefit: this._pickRandom(B_BENEFITS),
        };
      case 'problem_sol': {
        const b = this._pickRandom(PS_BLOCKS);
        return { hook: b.problem, explain: b.solution, benefit: b.outcome };
      }
      case 'social_proof': {
        const b = this._pickRandom(SP_BLOCKS);
        return { hook: b.hook, explain: b.note, benefit: b.benefit };
      }
      case 'direct_promo': {
        const b = this._pickRandom(DP_BLOCKS);
        return { hook: b.hook, explain: b.detail, benefit: b.benefit };
      }
    }
  }

  // ── Message assembly ──────────────────────────────────────────────────────────
  // Fixed structure: greeting → hook → *product header* → explain → benefit → [offer] → soft CTA → hard CTAs

  private _buildMessage(parts: {
    greeting: string;
    productName: string;
    sku: string;
    hook: string;
    explain: string;
    benefit: string;
    softCta: string;
    callLabel: string;
    telecallerPhone: string;
    productUrl: string;
    offerLine?: string;
  }): string {
    const {
      greeting, productName, sku, hook, explain, benefit,
      softCta, callLabel, telecallerPhone, productUrl, offerLine,
    } = parts;

    const lines: string[] = [
      greeting,
      ``,
      hook,
      ``,
      `*${productName}*`,
      `SKU: ${sku}`,
      ``,
      explain,
      ``,
      benefit,
    ];

    if (offerLine) {
      lines.push(``, offerLine);
    }

    lines.push(
      ``,
      softCta,
      ``,
      `📞 ${callLabel}: ${telecallerPhone}`,
      `🛍 View Product: ${productUrl}`,
    );

    return lines.join('\n');
  }

  // ── Product URL ───────────────────────────────────────────────────────────────
  // Prefer stored Shopify handle; derive from item name as fallback.

  private _buildProductUrl(product: ShopifyCatalogItem): string {
    if (product.handle) return `${STORE_BASE}/products/${product.handle}`;
    if (product.itemName) {
      const derived = product.itemName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (derived) return `${STORE_BASE}/products/${derived}`;
    }
    return STORE_BASE;
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
    if (emojiCount > 3) {
      this.logger.warn(`[PROMO_AI_SAFETY] emoji_count=${emojiCount} exceeds limit`);
    }
  }
}

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
  | 'educational'
  | 'problem_sol'
  | 'product_info'
  | 'benefit'
  | 'social_proof'
  | 'direct_promo';

// Cumulative thresholds — educational=30, problem_sol=25, product_info=20, benefit=15, social_proof=8, direct_promo=2
const CATEGORY_THRESHOLDS: [ContentCategory, number][] = [
  ['educational',  30],
  ['problem_sol',  55],
  ['product_info', 75],
  ['benefit',      90],
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

// ── Soft CTAs — invite a reply, no pressure ───────────────────────────────────
const SOFT_CTAS = [
  'Can share pricing if relevant.',
  'Can share dimensions if useful.',
  'Can share available variants.',
  'Can share MOQ details.',
  'Can share specifications if needed.',
  'Can share catalogue if useful.',
  'Happy to share more details if this is relevant.',
  'Can share stock availability if needed.',
  'Can share technical specifications if required.',
  'Happy to share options — just let me know what would be useful.',
];

// ── EDUCATIONAL hooks (30%) ───────────────────────────────────────────────────
// Industry insight. No product mention yet. Keep "display/showroom/visibility/browsing" out.
const ED_HOOKS: ((city: string) => string)[] = [
  (city) => city
    ? `Many businesses in ${city} spend more time reorganizing their product setup than they plan for.`
    : `Many businesses spend more time reorganizing their product setup than they plan for.`,
  (_) => `When a buyer can't locate what they came for quickly, most move on without asking.`,
  (_) => `Businesses that give each product a clear, accessible position tend to get more specific enquiries.`,
  (city) => city
    ? `B2B buyers in ${city} often work through a short list. Whether they find everything depends on how the layout is organized.`
    : `B2B buyers often work through a short list. Whether they find everything depends on how the layout is organized.`,
  (_) => `A product that's hard to reach is often skipped — even by buyers who were specifically looking for it.`,
  (_) => `When a product range grows, the organization challenge usually grows faster than the range itself.`,
  (city) => city
    ? `Businesses in ${city} managing a wide range often find that buyer engagement is more about layout than product selection.`
    : `Businesses managing a wide range often find that buyer engagement is more about layout than product selection.`,
  (_) => `How easy it is to pick up and examine a product affects whether buyers ask about it.`,
  (_) => `The same product generates different levels of interest depending on how accessible it is.`,
  (_) => `Buyers who can navigate a range independently tend to look at more items and ask better questions.`,
];

// Explains come after the bold product header — implicit subject is the product.
const ED_EXPLAINS: string[] = [
  `Works as a dedicated holder for individual products. Keeps each item in a fixed, accessible position.`,
  `Used where products need to be kept separated and easy to pick up — retail, wholesale, or storage setups.`,
  `Gives each product a defined space in a shared layout. No stacking or grouping needed.`,
  `A holder for individual product units. Straightforward to set up and adjust as the range changes.`,
  `Designed for situations where multiple products share a limited space. Each item gets its own position.`,
  `Commonly used to give products a fixed, accessible spot — easier to restock and easier for buyers to examine.`,
];

const ED_BENEFITS: string[] = [
  `Reduces time spent reorganizing during the day.`,
  `Buyers locate what they need without waiting for assistance.`,
  `Keeps the layout consistent even after restocking.`,
  `Less staff time on arrangement. More time for actual conversations.`,
  `Fewer products get overlooked. Buyers tend to cover more of the range.`,
  `Useful anywhere multiple products share limited space.`,
];

// ── PROBLEM_SOL blocks (25%) ──────────────────────────────────────────────────
// problem = hook text. solution and outcome follow the product header.
const PS_BLOCKS: { problem: string; solution: string; outcome: string }[] = [
  {
    problem: `Products that share space without separation are harder to pick up and examine individually.\nMost buyers skip grouped items — even relevant ones.`,
    solution: `Holds each product in its own position. Buyers examine items one at a time without moving others.`,
    outcome: `More products get evaluated per visit.`,
  },
  {
    problem: `Products that shift position under regular handling take time to reset.\nAcross a working day, that adds up.`,
    solution: `Holds its position under regular use. No constant readjustment needed.`,
    outcome: `Less daily maintenance. Layout stays consistent through the day.`,
  },
  {
    problem: `Adding new products to an existing setup often means rearranging everything around them.\nBusinesses lose time on this regularly.`,
    solution: `Modular design. New items fit in without disrupting the existing arrangement.`,
    outcome: `Range grows without reorganizing what is already working.`,
  },
  {
    problem: `Buyers who visit multiple branches expect consistent product placement.\nWhen it varies, they often can't find what they want without asking.`,
    solution: `Standardized across configurations. Same result in different locations without customization.`,
    outcome: `Consistent experience across branches. Less staff time spent on navigation.`,
  },
  {
    problem: `Without defined positions, products end up placed wherever space allows.\nThis makes it harder for buyers to find specific items.`,
    solution: `Assigns each product a fixed position. Buyers know where to look.`,
    outcome: `Buyers navigate the range independently. Fewer interruptions for staff.`,
  },
  {
    problem: `After restocking, products often don't return to the same spot.\nRestoring order before opening takes time.`,
    solution: `Products reload into fixed positions. Restocking stays consistent.`,
    outcome: `Less time organizing before and during the working day.`,
  },
];

// ── PRODUCT_INFO hooks (20%) ──────────────────────────────────────────────────
const PI_HOOKS: string[] = [
  `Quick note on something from our catalog — might be useful depending on what you are managing.`,
  `Sharing a product that tends to come up with businesses handling similar requirements.`,
  `One item from our range worth knowing about — especially if you are planning any layout updates.`,
  `Something from our catalog that covers a common product organization requirement.`,
  `A product from our range that might be worth adding to your list.`,
];

const PI_EXPLAINS: string[] = [
  `A product holder for organized, individual placement. Works with most standard configurations.`,
  `Used in retail and wholesale settings where products need defined positions — no custom installation required.`,
  `A holder that separates individual products within a shared space. Straightforward to set up.`,
  `Designed for individual product placement. Lightweight, modular, and easy to adjust as the range changes.`,
  `Used when multiple products share limited space and each needs a clear, accessible position.`,
];

const PI_BENEFITS: string[] = [
  `Standard configuration. No customization needed.`,
  `Durable under daily use. Minimal maintenance.`,
  `Easy to set up and adjust as the range changes.`,
  `Scales as the range grows. No structural changes required.`,
];

// ── BENEFIT hooks (15%) ───────────────────────────────────────────────────────
const BN_HOOKS: ((city: string) => string)[] = [
  (_) => `The products buyers spend the longest time with are usually the ones they can access without help.`,
  (_) => `Being able to find and examine a product quickly is often what turns a visit into an enquiry.`,
  (city) => city
    ? `For businesses in ${city} managing a broad range, how products are organized tends to determine how much of the range gets seen.`
    : `For businesses managing a broad range, how products are organized tends to determine how much of the range gets seen.`,
  (_) => `Small layout improvements tend to have a larger impact on buyer engagement than expected.`,
  (_) => `Products that are easy to pick up and examine independently get more enquiries than ones that need to be asked for.`,
];

const BN_EXPLAINS: string[] = [
  `Separates products within a shared space. Each item is accessible without moving others.`,
  `Gives every product a defined, reachable position in the layout.`,
  `Keeps products organized without requiring additional space.`,
  `Holds items individually — buyers can examine each one without disrupting the rest.`,
];

const BN_BENEFITS: string[] = [
  `Buyers spend more time per product. Enquiries tend to be more specific.`,
  `Fewer items go unnoticed. More of the range gets covered in a visit.`,
  `Less staff time spent assisting with navigation. More time for conversations.`,
  `Useful wherever buyers need to examine products individually before deciding.`,
  `Helps reduce how often buyers need assistance locating products.`,
];

// ── SOCIAL_PROOF blocks (8%) ──────────────────────────────────────────────────
const SP_BLOCKS: { hook: string; note: string; benefit: string }[] = [
  {
    hook: `This comes up regularly in conversations with businesses managing a wide product range.`,
    note: `Usually chosen for its consistent results and straightforward setup across different configurations.`,
    benefit: `Practical at different volumes. Holds up under regular use.`,
  },
  {
    hook: `One of our more consistently ordered items among businesses in this segment.`,
    note: `Often selected when businesses want organized product placement without complex installation.`,
    benefit: `Low maintenance. Works immediately once set up.`,
  },
  {
    hook: `Businesses that start with one set often come back for more as the range grows.`,
    note: `Used in retail and wholesale setups where individual product placement matters.`,
    benefit: `Easy to scale. Each addition fits with what is already in place.`,
  },
  {
    hook: `A product that tends to become a repeat order once businesses see it in practice.`,
    note: `Commonly used to replace ad-hoc arrangements that require constant maintenance.`,
    benefit: `Reduces daily setup time. Consistent results without ongoing adjustment.`,
  },
];

// ── DIRECT_PROMO blocks (2%) ──────────────────────────────────────────────────
const DP_BLOCKS: { hook: string; detail: string; benefit: string }[] = [
  {
    hook: `Sharing something from our catalog — might be relevant to what you are managing.`,
    detail: `A product holder for organized individual placement. In stock. Standard configurations available.`,
    benefit: `Fits most setups. No special installation required.`,
  },
  {
    hook: `Quick note on a product from our range.`,
    detail: `Used for organized product placement in retail and wholesale settings. Easy to set up.`,
    benefit: `Low maintenance. Works at different volumes.`,
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

    const category   = this._pickCategory();
    const greeting   = this._pickRandom(GREETINGS)(name);
    const softCta    = this._pickSoftCta(customer.phone);
    const callLabel  = this._pickRandom(CALL_LABELS);
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
      case 'educational':
        return {
          hook:    this._pickRandom(ED_HOOKS)(city),
          explain: this._pickRandom(ED_EXPLAINS),
          benefit: this._pickRandom(ED_BENEFITS),
        };
      case 'product_info':
        return {
          hook:    this._pickRandom(PI_HOOKS),
          explain: this._pickRandom(PI_EXPLAINS),
          benefit: this._pickRandom(PI_BENEFITS),
        };
      case 'benefit':
        return {
          hook:    this._pickRandom(BN_HOOKS)(city),
          explain: this._pickRandom(BN_EXPLAINS),
          benefit: this._pickRandom(BN_BENEFITS),
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
  // Structure: greeting → hook → *product header* → explain → benefit → [offer] → soft CTA → hard CTAs

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
  // Prefer stored Shopify handle; derive slug from item name as fallback.

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

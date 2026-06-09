import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';
import { buildCta } from '../shared/cta-builder';

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
  /** Product page URL — stored in message_payload for analytics; displayed below the product CTA label. */
  productUrl: string;
  /** True when message scored above quality threshold within MAX_REGENERATION_ATTEMPTS. */
  qualityPassed: boolean;
  /** Quality scores and attempt count for the final generated message. */
  quality: {
    finalScore:   number;
    attemptsUsed: number;
    grade:        'PASS' | 'REVIEW' | 'FAIL';
  };
  metadata: {
    templateVariant:       string;
    contentCategory:       ContentCategory;
    hookType:              string;
    messageLength:         number;
    productSku:            string;
    productClass:          ProductClass;
    industryContext:       string | null;
    knowledgeConfidence:   number;
    businessProblem:       string;
    /**
     * How the product URL was resolved:
     *   handle  — real Shopify handle used → /products/{handle}  (correct)
     *   search  — no handle; SKU search fallback used → /search?q=SKU
     *   rejected — no handle and no SKU; product was skipped
     */
    urlSource:             'handle' | 'search' | 'rejected';
    /** First 1–2 lines of the message — appear in WhatsApp notification preview before opening. */
    notificationHook:      string;
    /** Validation flags from _validateHook — empty array = hook is clean. */
    hookValidationFlags:   string[];
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT CLASSIFICATION — 6 Hesh divisions + general
// ══════════════════════════════════════════════════════════════════════════════

type ProductClass =
  | 'display'       // DISPLAY FACTORY: wall displays, counters, lens trays, storage, mirrors
  | 'machine'       // MACHINE COMPANY: refractometers, phoropters, slit lamps, edgers
  | 'case'          // CASE FACTORY: EVA cases, metal cases, soft cases, plastic cases
  | 'lens_cleaner'  // LENS CLEANER FACTORY: lens cleaner, cleaning kits
  | 'microfiber'    // MICROFIBER FACTORY: cleaning cloth, GSM variations
  | 'tool'          // TOOLS COMPANY: fitting supplies, maintenance items, optical accessories
  | 'general';

const DISPLAY_TERMS    = /display|panel|tray|holder|rack|counter|wall|shelf|stand|fixture|mount|mirror|cabinet|sunglass\s*display|frame\s*display|lens\s*tray|display\s*furniture|storage\s*unit/i;
const MACHINE_TERMS    = /refractometer|phoropter|slit\s*lamp|edger|lens\s*edger|autoref|auto\s*ref|lensometer|focimeter|keratometer|tonometer|perimeter|visual\s*field|instrument|equipment|machine/i;
const CASE_TERMS       = /case|eva\s*case|metal\s*case|hard\s*case|soft\s*case|spectacle\s*case|eyewear\s*case|frame\s*case|glasses\s*case|pouch|box/i;
const CLEANER_TERMS    = /lens\s*cleaner|cleaning\s*kit|cleaning\s*spray|cleaning\s*solution|lens\s*spray|lens\s*solution|cleaner\s*kit|optical\s*cleaner/i;
const MICROFIBER_TERMS = /microfiber|micro\s*fiber|cleaning\s*cloth|gsm\s*cloth|optical\s*cloth|lens\s*cloth|cleaning\s*towel/i;
const TOOL_TERMS       = /screw|screwdriver|plier|fitting\s*tool|nose\s*pad|temple|hinge|repair\s*kit|optical\s*tool|frame\s*tool|adjustment\s*tool|pd\s*ruler|pupillometer|height\s*gauge|pantoscopic|fitting\s*kit/i;

function classifyProduct(product: ShopifyCatalogItem): ProductClass {
  const allText = [
    product.itemName,
    product.description,
    product.tags,
    product.productType,
    product.handle,
    product.vendor,
    product.sku,
  ].filter(Boolean).join(' ');

  if (CLEANER_TERMS.test(allText))    return 'lens_cleaner';
  if (MICROFIBER_TERMS.test(allText)) return 'microfiber';
  if (MACHINE_TERMS.test(allText))    return 'machine';
  if (DISPLAY_TERMS.test(allText))    return 'display';
  if (CASE_TERMS.test(allText))       return 'case';
  if (TOOL_TERMS.test(allText))       return 'tool';

  const unit = product.unit?.trim().toLowerCase() ?? '';
  if (/^(l|ml|ltr|litre|liter)$/.test(unit)) return 'lens_cleaner';

  return 'general';
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT CATEGORIES & WEIGHTS
// ══════════════════════════════════════════════════════════════════════════════

type ContentCategory =
  | 'problem_based'      // 35% — business pain this product solves
  | 'observation_based'  // 25% — pattern observed in the industry
  | 'workflow_based'     // 20% — day-to-day friction angle
  | 'educational'        // 15% — teach something, earn trust
  | 'lead_starter';      //  5% — direct intro to Hesh as manufacturer

// Cumulative thresholds
const CATEGORY_THRESHOLDS: [ContentCategory, number][] = [
  ['problem_based',     35],
  ['observation_based', 60],
  ['workflow_based',    80],
  ['educational',       95],
  ['lead_starter',      100],
];

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ROTATION POOLS
// ══════════════════════════════════════════════════════════════════════════════

// Rotate between natural WhatsApp call labels
const CALL_LABELS = ['Call or WhatsApp Us', 'Call / WhatsApp Us'];

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT BLOCK — short form, optimised for curiosity → understanding → action
//
// Structure in message:
//   hook → pain → *product* → benefit → trigger → 🛍 CTA → 📞 CTA
//
// Rules:
//   pain    — ≤12 words, 1 sentence, simple Indian English
//   benefit — ≤12 words, 1 sentence, starts with action ("Helps", "Lets", "Keeps", etc.)
//   trigger — ≤12 words, mandatory question, ends with ?
// ══════════════════════════════════════════════════════════════════════════════

interface ContentBlock {
  pain:    string;  // ≤12 words — single sentence pain/observation
  benefit: string;  // ≤12 words — what the product does (1 sentence max)
  trigger: string;  // question ≤12 words, ends with ?
}

interface ProductClassPools {
  problem_based:     ContentBlock[];
  observation_based: ContentBlock[];
  workflow_based:    ContentBlock[];
  educational:       ContentBlock[];
  lead_starter:      ContentBlock[];
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPLAY FACTORY — wall displays, counters, lens trays, storage, mirrors
// ══════════════════════════════════════════════════════════════════════════════

const DISPLAY_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Most stores display under 20% of the frames they actually stock.`,
      benefit: `Helps get more of your range on the floor and in front of customers.`,
      trigger: `How much of your current range is sitting in storage right now?`,
    },
    {
      pain:    `Customers cannot buy frames they never notice on your floor.`,
      benefit: `Lets customers browse your full range without needing staff help.`,
      trigger: `Does your display let customers browse on their own?`,
    },
    {
      pain:    `Restocking after a busy day takes longer than it should.`,
      benefit: `Keeps every frame in a fixed position so restocking is fast.`,
      trigger: `How long does display restocking take after your busy hours?`,
    },
    {
      pain:    `Unsorted lens trays slow down the dispensing bench during peak hours.`,
      benefit: `Keeps the dispensing bench sorted and accurate under pressure.`,
      trigger: `How are you currently organizing lens stock at the bench?`,
    },
  ],

  observation_based: [
    {
      pain:    `Frames customers cannot see on the floor, they assume you don't carry.`,
      benefit: `Helps display your full range in a way customers can browse easily.`,
      trigger: `How are your frames laid out — by brand, price, or style?`,
    },
    {
      pain:    `A badly placed mirror gets a quick glance, not a real try-on.`,
      benefit: `Gives customers the right angle and space to try each frame properly.`,
      trigger: `How many try-on mirrors do you have — and where are they?`,
    },
    {
      pain:    `Higher-margin frames placed behind the front row rarely get tried.`,
      benefit: `Spreads customer attention across all display zones, not just the front.`,
      trigger: `Have you tracked which part of your display drives the most trials?`,
    },
  ],

  workflow_based: [
    {
      pain:    `New arrivals go to storage when the floor has no space for them.`,
      benefit: `Lets you expand display capacity without redesigning the full floor.`,
      trigger: `How quickly do new arrivals actually make it onto your display?`,
    },
    {
      pain:    `Mixed brand racks make customers miss entire segments they would browse.`,
      benefit: `Keeps brand zones separate and clear without a full floor redesign.`,
      trigger: `Are your brands displayed separately or sharing the same racks?`,
    },
    {
      pain:    `A counter handling display, dispensing, and storage does none well.`,
      benefit: `Separates the try-on and dispensing zones so each works properly.`,
      trigger: `How is your counter space divided between display and dispensing?`,
    },
  ],

  educational: [
    {
      pain:    `High-margin frames in low-traffic spots get fewer trials than they should.`,
      benefit: `Puts your best frames in positions where customers naturally look first.`,
      trigger: `Are your highest-margin frames in your most prominent position?`,
    },
    {
      pain:    `A wall mirror doesn't give the angle a proper try-on station does.`,
      benefit: `Gives customers the height and angle needed to evaluate each frame.`,
      trigger: `What mirror setup are you using for frame trials right now?`,
    },
    {
      pain:    `An unplanned floor layout takes weeks to replicate in a new branch.`,
      benefit: `Replicates the same layout across branches without redesign or guesswork.`,
      trigger: `If you opened a second branch today, how long would setup take?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Generic furniture isn't designed for how optical stores display frames.`,
      benefit: `Built specifically for how spectacle frames need to be displayed and organized.`,
      trigger: `What does your current display setup look like right now?`,
    },
    {
      pain:    `Parts from multiple suppliers never quite match in size or finish.`,
      benefit: `Designed to work together as a complete system — wall, counter, and tray.`,
      trigger: `Are you upgrading specific parts or planning a full setup?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// MACHINE COMPANY — refractometers, phoropters, slit lamps, edgers, lab equipment
// ══════════════════════════════════════════════════════════════════════════════

const MACHINE_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Slow refraction backs up the entire patient queue for the rest of the day.`,
      benefit: `Gives accurate preliminary readings in under 2 minutes per patient.`,
      trigger: `How long is the refraction stage taking on a busy afternoon?`,
    },
    {
      pain:    `Sending lens jobs outside adds cost per lens and makes customers wait.`,
      benefit: `Brings jobs back in-house with same-day turnaround on most work.`,
      trigger: `What's your daily lens job volume — and how much goes outside?`,
    },
    {
      pain:    `One instrument down stops your entire patient flow for the day.`,
      benefit: `Removes the single-point dependency so work continues when one is serviced.`,
      trigger: `Do you have backup coverage for your key examination instruments?`,
    },
  ],

  observation_based: [
    {
      pain:    `Patients who feel processed rather than examined rarely come back.`,
      benefit: `Signals a clinical standard that builds patient trust from the first visit.`,
      trigger: `What instruments are you using — and what are you thinking of adding?`,
    },
    {
      pain:    `Patients notice when your equipment doesn't match what they've seen elsewhere.`,
      benefit: `Improves both the speed and the feel of each examination.`,
      trigger: `Are you currently using manual or digital equipment for refraction?`,
    },
  ],

  workflow_based: [
    {
      pain:    `Inconsistent edging on drill-mount and rimless jobs creates fitting complaints.`,
      benefit: `Removes operator variation so every job comes out to the same standard.`,
      trigger: `What's your rework rate on drill-mount and rimless jobs currently?`,
    },
    {
      pain:    `Skipping slit lamp means relying entirely on autorefractor readings alone.`,
      benefit: `Takes only a few minutes and changes the depth of every consultation.`,
      trigger: `Is slit lamp part of your standard consultation flow right now?`,
    },
    {
      pain:    `One instrument handling the full day's load backs up everything behind it.`,
      benefit: `Lets each stage run independently so no queue builds behind one step.`,
      trigger: `Where is the slowest point in your current patient flow?`,
    },
  ],

  educational: [
    {
      pain:    `Patients don't evaluate clinical quality but they notice how well they're treated.`,
      benefit: `Equipment beyond basic refraction changes how every patient experiences the visit.`,
      trigger: `What's driving patients to your practice over nearby alternatives?`,
    },
    {
      pain:    `Progressive edging has a 1mm tolerance — outside errors come back as complaints.`,
      benefit: `Gives direct control over fit quality on every progressive job.`,
      trigger: `Are you edging progressive jobs in-house or sending them outside?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Most equipment purchases come with no clarity on what support follows.`,
      benefit: `Covers installation, calibration, and after-purchase support for every instrument.`,
      trigger: `What instruments are you using — and what's the next addition you're planning?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// CASE FACTORY — EVA cases, metal cases, soft cases, plastic cases
// ══════════════════════════════════════════════════════════════════════════════

const CASE_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Customers without a proper case find their own storage — usually the wrong kind.`,
      benefit: `Protects lenses from the very first day the glasses go home.`,
      trigger: `Are you including a case with every purchase, or only on request?`,
    },
    {
      pain:    `Kids' eyewear has a much higher damage rate without a proper hard case.`,
      benefit: `Absorbs the daily impact and handling from younger wearers.`,
      trigger: `What case are you recommending for children's eyewear right now?`,
    },
    {
      pain:    `Handing over glasses in a thin sleeve doesn't match what was paid for.`,
      benefit: `Makes the purchase feel complete and considered at the moment of handover.`,
      trigger: `What case type are you using at handover across your price ranges?`,
    },
  ],

  observation_based: [
    {
      pain:    `Cheap soft pouches get lost — your brand goes with them.`,
      benefit: `Stays in the customer's daily routine for years, keeping your store visible.`,
      trigger: `Are you using branded cases or plain stock from your supplier?`,
    },
    {
      pain:    `Most stores miss a simple upsell — no premium case is offered at checkout.`,
      benefit: `Creates a natural upsell at checkout without any extra selling conversation.`,
      trigger: `Do you offer premium case upgrades as a paid option?`,
    },
  ],

  workflow_based: [
    {
      pain:    `Running out of the right size at checkout leaves the customer disappointed.`,
      benefit: `Keeps checkout moving without last-minute substitutions or delays.`,
      trigger: `How are you managing case inventory — bulk stock or ordered per sale?`,
    },
    {
      pain:    `A basic pouch with a high-value lens doesn't match the price the customer paid.`,
      benefit: `Matches case quality to lens value so the handover makes sense.`,
      trigger: `Do you match case quality to the lens value being dispensed?`,
    },
  ],

  educational: [
    {
      pain:    `Soft pouches allow lens contact inside — that friction damages coatings over time.`,
      benefit: `Prevents internal movement so coatings stay intact through daily use.`,
      trigger: `What case type do you recommend for high-index or coated lenses?`,
    },
    {
      pain:    `Plain generic cases carry no identity — customers forget your store quickly.`,
      benefit: `Puts your store name in the customer's hand every single morning.`,
      trigger: `Have you looked at branded case options, or still on plain stock?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Most stores source cases from multiple suppliers and get inconsistent quality.`,
      benefit: `EVA, metal, and soft cases manufactured direct from our factory in Chennai.`,
      trigger: `What case formats are you stocking — and what's your monthly volume?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// LENS CLEANER FACTORY — lens cleaner, cleaning kits
// ══════════════════════════════════════════════════════════════════════════════

const LENS_CLEANER_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Most coating damage happens in the first few months — always the wrong cleaner.`,
      benefit: `Prevents the most common coating damage pattern from the very first clean.`,
      trigger: `Are you handing over a lens cleaner with every purchase?`,
    },
    {
      pain:    `Most customers don't know the right way to clean coated lenses.`,
      benefit: `Prevents post-sale coating complaints before they start.`,
      trigger: `Do you walk customers through lens care at the point of handover?`,
    },
  ],

  observation_based: [
    {
      pain:    `Repeat lens cleaner purchases go to pharmacies — not back to your counter.`,
      benefit: `Captures that repeat purchase and keeps customers coming back to you.`,
      trigger: `Are customers coming back to you for cleaning products?`,
    },
    {
      pain:    `Stores that wait to be asked about care products miss the moment entirely.`,
      benefit: `Makes you the ongoing lens care expert, not just the place they dispensed from.`,
      trigger: `What does your current post-sale lens care recommendation look like?`,
    },
  ],

  workflow_based: [
    {
      pain:    `Most stores skip the proactive offer and lose a clean add-on every transaction.`,
      benefit: `Adds to transaction value at handover without any extra selling time.`,
      trigger: `What's your current add-on rate at checkout — cleaning products, cases?`,
    },
    {
      pain:    `Running out mid-month means customers who ask leave your counter without one.`,
      benefit: `Keeps the counter stocked and the repeat purchase reason intact.`,
      trigger: `How many units are you moving per month — dispensing and retail combined?`,
    },
  ],

  educational: [
    {
      pain:    `Different coatings have specific pH tolerances — wrong cleaners degrade them.`,
      benefit: `Safe for all lens types — anti-reflective, blue-light, and photochromic.`,
      trigger: `Do you recommend the same cleaner for all lens types right now?`,
    },
    {
      pain:    `Most stores treat lens care as an afterthought — a pouch with no guidance.`,
      benefit: `Turns handover into a moment of care that customers remember and mention.`,
      trigger: `What's the last thing a customer receives before walking out of your store?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Retail-sourced cleaners often react poorly with advanced lens coatings.`,
      benefit: `pH-balanced for anti-reflective, blue-light, and photochromic coatings.`,
      trigger: `How many units per month — for dispensing and counter retail?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// MICROFIBER FACTORY — cleaning cloth, GSM variations
// ══════════════════════════════════════════════════════════════════════════════

const MICROFIBER_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Customers using tissue or clothing cause coating damage from the first clean.`,
      benefit: `Protects lens surfaces from abrasive damage starting from day one.`,
      trigger: `What cleaning cloth are you sending out with every pair you dispense?`,
    },
    {
      pain:    `Low-quality microfiber degrades after 8–10 washes — customers switch to tissue.`,
      benefit: `Holds cleaning performance through 50+ wash cycles without losing texture.`,
      trigger: `How long do customers use the cloth before they stop using it?`,
    },
  ],

  observation_based: [
    {
      pain:    `Glasses handed over without a quality cloth feel like an incomplete purchase.`,
      benefit: `Makes the handover feel complete and adds a branded daily touchpoint.`,
      trigger: `Are you branding your microfiber cloths or using plain unbranded stock?`,
    },
    {
      pain:    `Customers who need a replacement cloth buy it wherever is most convenient.`,
      benefit: `Creates a simple repeat visit reason at very low inventory cost.`,
      trigger: `Do you currently sell cloths separately as a retail item?`,
    },
  ],

  workflow_based: [
    {
      pain:    `Using different cloths for different price ranges creates confusion and mismatches.`,
      benefit: `One specification covers all lens types and frame price points cleanly.`,
      trigger: `Do you use different cloth grades for different price ranges?`,
    },
    {
      pain:    `Buying microfiber in small batches means paying near-retail rates every time.`,
      benefit: `Brings unit cost down and removes the urgent reorder problem entirely.`,
      trigger: `What's your monthly cloth volume — and how are you currently sourcing them?`,
    },
  ],

  educational: [
    {
      pain:    `Most stores pick cloths on price — 200 GSM and 400 GSM perform very differently.`,
      benefit: `Higher GSM cleans better, leaves no lint, and survives far more washes.`,
      trigger: `Would it help to compare GSM options against what you currently stock?`,
    },
  ],

  lead_starter: [
    {
      pain:    `General suppliers give inconsistent GSM and sizing from batch to batch.`,
      benefit: `Consistent dimensions and cleaning performance in every order we supply.`,
      trigger: `How many cloths per month — for dispensing and for retail sale?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// TOOLS COMPANY — fitting supplies, maintenance items, optical accessories
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `A frame that doesn't fit properly at home means a return visit the next day.`,
      benefit: `Ensures every frame leaves fitting correctly the first time.`,
      trigger: `Do you have a full fitting toolkit at each counter, or one shared set?`,
    },
    {
      pain:    `Minor repairs that take 10 minutes in-house are being sent out for a week.`,
      benefit: `Handles the most common frame repairs in-house on the same day.`,
      trigger: `What percentage of repairs are you currently handling in-house?`,
    },
    {
      pain:    `Incorrect acetate adjustment can crack the frame — a difficult conversation follows.`,
      benefit: `Reduces the risk of frame damage for every material type handled.`,
      trigger: `Do your current tools differentiate between acetate, metal, and titanium?`,
    },
  ],

  observation_based: [
    {
      pain:    `A poor or slow fitting leaves an impression the frame price can't fix.`,
      benefit: `Signals professional competence from the moment the fitting begins.`,
      trigger: `What does your current fitting process look like at handover?`,
    },
    {
      pain:    `Progressive lens accuracy depends directly on getting measurements right.`,
      benefit: `Takes the guesswork out of progressive dispensing with proper measurement.`,
      trigger: `What measurement tools are you using when dispensing progressive lenses?`,
    },
  ],

  workflow_based: [
    {
      pain:    `A fitting that should take 5 minutes is taking 15–20 without the right tools.`,
      benefit: `Keeps fittings fast, accurate, and consistent across your full team.`,
      trigger: `How long does a typical frame fitting take in your practice right now?`,
    },
    {
      pain:    `Sharing one toolkit across counters slows every station during peak hours.`,
      benefit: `Lets every dispensing counter work independently without waiting.`,
      trigger: `How many dispensing counters do you have — each with its own toolkit?`,
    },
  ],

  educational: [
    {
      pain:    `Progressive fitting has a ±1mm tolerance — small errors reduce optical performance.`,
      benefit: `Removes guesswork from progressive dispensing with accurate measurements.`,
      trigger: `What measurement tools do you use when dispensing progressive prescriptions?`,
    },
    {
      pain:    `Different frame materials need completely different fitting and adjustment approaches.`,
      benefit: `Prevents the most common fitting errors before they happen in front of customers.`,
      trigger: `Which frame material does your team find most challenging to adjust?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Most opticians adapt adjustment tools from hardware or jewelry stores.`,
      benefit: `Designed specifically for optical frame fitting — not adapted from other uses.`,
      trigger: `What does your current fitting toolkit look like — any gaps you've noticed?`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// GENERAL — cross-division, Hesh manufacturer context
// ══════════════════════════════════════════════════════════════════════════════

const GENERAL_POOLS: ProductClassPools = {

  problem_based: [
    {
      pain:    `Every time you say 'we don't carry that', a customer finds another store.`,
      benefit: `Keeps more conversations and more revenue inside your store.`,
      trigger: `What are customers asking for that you're currently sending them elsewhere?`,
    },
    {
      pain:    `Managing 4–5 suppliers for accessories and consumables adds hidden admin cost.`,
      benefit: `Consolidating to fewer reliable suppliers removes that overhead significantly.`,
      trigger: `How many suppliers are you currently managing for accessories?`,
    },
  ],

  observation_based: [
    {
      pain:    `Stores focused only on frames give customers no reason to visit between cycles.`,
      benefit: `Creates repeat visit reasons across the full prescription cycle.`,
      trigger: `What percentage of your revenue comes from accessories versus frames and lenses?`,
    },
    {
      pain:    `Optical retail is shifting — stores that go beyond dispensing are growing faster.`,
      benefit: `Deepens the relationship with customers you already have.`,
      trigger: `Are you actively growing your accessory range, or staying focused on frames?`,
    },
  ],

  workflow_based: [
    {
      pain:    `Ordering when stock runs out creates gaps that interrupt smooth day-to-day work.`,
      benefit: `Makes reordering predictable and removes the reactive stock problem.`,
      trigger: `What are you currently sourcing reactively rather than planning in advance?`,
    },
    {
      pain:    `Follow-ups, mismatched deliveries, and invoices across 5 suppliers add up fast.`,
      benefit: `Consolidates multiple categories into one relationship and one order cycle.`,
      trigger: `How much time per week does your team spend on supplier follow-up?`,
    },
  ],

  educational: [
    {
      pain:    `Most stores split 6 product categories across 5 or more different suppliers.`,
      benefit: `Supplies displays, instruments, cases, cleaners, microfiber, and tools direct.`,
      trigger: `Which of these categories are you sourcing from multiple different suppliers?`,
    },
    {
      pain:    `Through a distributor, queries and complaints take weeks to reach the source.`,
      benefit: `Direct manufacturer means queries reach the source on the same day.`,
      trigger: `How much of your supply is manufacturer-direct versus through a distributor?`,
    },
  ],

  lead_starter: [
    {
      pain:    `Going through distributors adds cost and lead time without adding product value.`,
      benefit: `Displays, instruments, cases, cleaners, microfiber, and tools — all from factory.`,
      trigger: `What are you sourcing that you'd explore with a direct manufacturer?`,
    },
  ],
};

const POOL_MAP: Record<ProductClass, ProductClassPools> = {
  display:      DISPLAY_POOLS,
  machine:      MACHINE_POOLS,
  case:         CASE_POOLS,
  lens_cleaner: LENS_CLEANER_POOLS,
  microfiber:   MICROFIBER_POOLS,
  tool:         TOOL_POOLS,
  general:      GENERAL_POOLS,
};

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION HOOK POOLS — appear FIRST in message, shown in notification preview
// Rules: 40–80 chars, max 2 lines, no product names, no greetings, no company
//        name, no SKU, no URLs, no phone numbers, no emojis.
// Goal: create curiosity before the message is even opened.
// ══════════════════════════════════════════════════════════════════════════════

const DISPLAY_HOOKS: readonly string[] = [
  'Most optical stores display fewer than 20% of the frames they stock.',
  "What customers can't see on the floor, they won't buy.",
  'How much of your current range is sitting in storage right now?',
  'The front row drives most trials. Frames behind it rarely get touched.',
  'New arrivals that go to storage instead of the floor lose their window.',
  'Daily display restocking after a busy shift — how long is that taking?',
  'Your highest-margin frames may be in your least-noticed position.',
];

const MACHINE_HOOKS: readonly string[] = [
  'Outsourcing lens edging adds cost per lens and makes every customer wait.',
  'One refractometer out of service means your entire patient flow stops.',
  'How long is refraction taking on a busy afternoon — and what queues behind?',
  'Patients who feel processed rather than examined rarely refer others.',
  'Progressive jobs edged outside the practice come back as adaptation complaints.',
  'Every outsourced minor repair adds 3-7 days to a customer wait.',
  'A nearby practice upgraded recently. Patients who have seen both notice.',
];

const CASE_HOOKS: readonly string[] = [
  'Most lens coating damage starts with the wrong case — not the lens.',
  'The case a customer takes home is in their hands every single morning.',
  'Customers who damage lenses within 6 months usually blame the lens, not storage.',
  'The handover moment is the last impression — what does yours say?',
  'A cheap case is the most expensive thing an optical store puts in every bag.',
  'Customers who get a good case are more likely to return when it needs replacing.',
];

const LENS_CLEANER_HOOKS: readonly string[] = [
  'Most coating damage happens in the first 3 months — always the wrong cleaner.',
  'Repeat lens cleaner purchases go to pharmacies — not back to you.',
  'Coating complaints 6 months out are almost always a cleaning problem.',
  'How much repeat-purchase revenue is walking out of your store monthly?',
  'A lens cleaner at handover prevents the most common post-sale complaint.',
];

const MICROFIBER_HOOKS: readonly string[] = [
  'Low-quality microfiber lasts 8-10 washes. After that, customers use their shirt.',
  'The first lens scratch usually comes from the wrong cleaning cloth.',
  'Customers finish the cloth you gave them and buy the next one somewhere else.',
  "Branded cloths are in the customer's hands every morning. Plain ones aren't.",
  'What cleaning cloth are you currently sending home with every pair you dispense?',
];

const TOOL_HOOKS: readonly string[] = [
  "A frame that doesn't fit when the customer gets home is a return visit tomorrow.",
  'Minor repairs that take 10 minutes in-house are being sent out for a week.',
  'A fitting that should take 5 minutes is taking 15-20 in most dispensaries.',
  'Progressive lens needs accurate fitting — not adjusting by feel.',
  'Staff sharing one toolkit across counters slows every counter during peak hours.',
  'How many frame repairs are you outsourcing that could be done in-house today?',
];

const GENERAL_HOOKS: readonly string[] = [
  "Every time you say 'we don't carry that,' a customer finds another store.",
  'How many suppliers are you managing for optical accessories and consumables?',
  'Reactive sourcing means running out mid-month and repeating the same problem.',
  'Accessories from 4-5 vendors — one supplier relationship can cover all of it.',
  'Accessory stock creates more customer visits between prescription cycles.',
  'Four suppliers, four invoices, four follow-ups — one could cover all of this.',
  "How much repeat-purchase revenue is leaving through products you don't stock?",
];

const HOOK_POOLS: Record<ProductClass, readonly string[]> = {
  display:      DISPLAY_HOOKS,
  machine:      MACHINE_HOOKS,
  case:         CASE_HOOKS,
  lens_cleaner: LENS_CLEANER_HOOKS,
  microfiber:   MICROFIBER_HOOKS,
  tool:         TOOL_HOOKS,
  general:      GENERAL_HOOKS,
};

// ══════════════════════════════════════════════════════════════════════════════
// BUSINESS CONTEXT LAYER
// ══════════════════════════════════════════════════════════════════════════════

interface BusinessContext {
  businessProblem:   string;
  usageScenario:     string;
  businessValue:     string;
  conversationAngle: string;
}

function deriveBusinessContext(
  productClass: ProductClass,
  knowledge: ProductKnowledge,
): BusinessContext {
  const use = knowledge.primaryUse;

  switch (productClass) {
    case 'display':
      return {
        businessProblem:   'under-displayed inventory and poor floor utilization',
        usageScenario:     'organizing frame and product display across counters and wall panels',
        businessValue:     'more active inventory, fewer products in dead storage, better customer self-navigation',
        conversationAngle: 'how many products they currently display versus what they actually carry',
      };
    case 'machine':
      return {
        businessProblem:   'patient throughput bottlenecks and outsourcing dependency for lens work',
        usageScenario:     use ?? 'examination and in-house lens processing',
        businessValue:     'faster patient flow, in-house quality control, reduced outsourcing cost',
        conversationAngle: 'what examination instruments they use and what work they currently outsource',
      };
    case 'case':
      return {
        businessProblem:   'lens damage complaints and generic handover experience',
        usageScenario:     'packaging and protecting dispensed eyewear at point of sale',
        businessValue:     'fewer post-sale complaints, higher perceived value, brand recall through daily use',
        conversationAngle: 'what case type they currently use at handover and whether it matches their pricing',
      };
    case 'lens_cleaner':
      return {
        businessProblem:   'coating damage from improper cleaning and missed repeat purchase opportunities',
        usageScenario:     'daily lens care and maintenance for dispensed eyewear',
        businessValue:     'longer lens life, fewer coating complaints, repeat purchases at the counter',
        conversationAngle: 'whether they provide cleaning products at handover and where customers currently buy them',
      };
    case 'microfiber':
      return {
        businessProblem:   'coating abrasion from wrong cleaning materials and weak handover experience',
        usageScenario:     'daily lens surface cleaning and care',
        businessValue:     'protected lens coatings, premium handover feel, branded daily-use touchpoint',
        conversationAngle: 'what cloth they currently dispense and whether they are branding it',
      };
    case 'tool':
      return {
        businessProblem:   'inaccurate fittings and outsourced repairs that should be resolved in-house',
        usageScenario:     'frame fitting, adjustment, and in-house repair at the dispensing counter',
        businessValue:     'faster fittings, consistent accuracy, fewer return visits from poor adjustments',
        conversationAngle: 'what tools they currently have at each counter and what repairs they send out',
      };
    default:
      return {
        businessProblem:   'fragmented supply and unmet customer requests from limited accessory range',
        usageScenario:     use ?? 'regular optical business operations',
        businessValue:     'fewer customer walk-aways, consolidated supply, more revenue per customer',
        conversationAngle: 'what accessories they carry and how many suppliers they currently manage',
      };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE LAYER — optical-industry aware extraction
// ══════════════════════════════════════════════════════════════════════════════

interface ProductKnowledge {
  productType:     string;
  primaryUse:      string | null;
  targetUser:      string | null;
  material:        string | null;
  industryContext: string | null;
  enrich:          string | null;
  confidence:      number; // 0–100
}

const INDUSTRY_KEYWORDS: [string, string][] = [
  ['optical',    'optical retail and dispensing'],
  ['optometry',  'optometry practice'],
  ['ophthalmic', 'ophthalmic practice'],
  ['lens',       'optical lens processing'],
  ['spectacle',  'spectacle dispensing'],
  ['eyewear',    'eyewear retail'],
  ['dispensary', 'optical dispensary'],
  ['refraction', 'optometry practice'],
  ['dispensing', 'spectacle dispensing'],
  ['frame',      'optical retail and dispensing'],
  ['optic',      'optical retail and dispensing'],
  ['lab',        'optical lab'],
  ['edging',     'optical lens lab'],
];

const USE_KEYWORDS: [string, string][] = [
  ['refraction',  'eye examination and refraction'],
  ['edging',      'lens edging and cutting'],
  ['dispensing',  'spectacle dispensing'],
  ['fitting',     'frame fitting and adjustment'],
  ['cleaning',    'lens cleaning and maintenance'],
  ['adjusting',   'frame adjustment'],
  ['mounting',    'frame mounting and assembly'],
  ['display',     'product display and organization'],
  ['organizing',  'product organization'],
  ['testing',     'vision testing'],
];

const MATERIAL_KEYWORDS: string[] = [
  'acetate', 'titanium', 'polycarbonate', 'trivex', 'cr-39', 'stainless',
  'aluminum', 'rubber', 'silicone', 'metal', 'plastic', 'glass',
  'eva', 'nylon', 'carbon', 'fiber', 'microfiber',
];

const TARGET_USER_MAP: Record<string, string> = {
  'optical retail and dispensing':   'optical stores and dispensaries',
  'optometry practice':              'optometrists and eye care practices',
  'ophthalmic practice':             'ophthalmic practices and clinics',
  'optical lens processing':         'optical lens labs',
  'spectacle dispensing':            'optical dispensaries',
  'eyewear retail':                  'eyewear retailers',
  'optical dispensary':              'optical dispensaries',
  'optical lab':                     'optical labs',
};

const HSN_INDUSTRY_MAP: Record<string, string> = {
  '9001': 'optical retail and dispensing',
  '9002': 'optical retail and dispensing',
  '9003': 'optical retail and dispensing',
  '9004': 'optical retail and dispensing',
  '9013': 'optical retail and dispensing',
  '9018': 'ophthalmic practice',
  '6307': 'optical retail and dispensing',
  '3402': 'optical retail and dispensing',
  '3405': 'lens cleaning and maintenance',
  '6804': 'optical lens lab',
  '8460': 'optical lens lab',
  '8461': 'optical lens lab',
  '3920': 'packaging industry',
  '4015': 'healthcare',
};

const PRODUCT_TYPE_NOUNS: string[] = [
  'refractometer', 'phoropter', 'edger', 'lensometer', 'keratometer',
  'display', 'panel', 'tray', 'rack', 'counter', 'stand', 'shelf', 'mirror', 'fixture',
  'case', 'pouch', 'box',
  'cleaner', 'solution', 'spray', 'kit',
  'cloth', 'microfiber',
  'tool', 'screwdriver', 'plier', 'gauge', 'ruler',
  'wheel', 'blade', 'machine', 'device', 'instrument',
];

type TextLayer = [string, string, number];

function buildTextLayers(product: ShopifyCatalogItem): TextLayer[] {
  return [
    [(product.description  ?? '').toLowerCase(), 'description',   30],
    [(product.tags         ?? '').toLowerCase(), 'tags',          20],
    [(product.productType  ?? '').toLowerCase(), 'productType',   15],
    [(product.itemName     ?? '').toLowerCase(), 'name',          15],
    [(product.handle       ?? '').toLowerCase(), 'handle',        10],
    [(product.vendor       ?? '').toLowerCase(), 'vendor',         5],
  ];
}

function deriveProductType(words: string[]): string {
  for (const noun of PRODUCT_TYPE_NOUNS) {
    if (words.includes(noun)) return noun;
  }
  const stop = new Set(['for', 'and', 'the', 'of', 'in', 'a', 'an', 'with', 'to', 'by', 'on']);
  const candidates = words.filter(w => !stop.has(w) && w.length > 2 && !/^\d/.test(w));
  return candidates[candidates.length - 1] ?? 'product';
}

function buildEnrichSentence(
  _productType: string,
  _primaryUse: string | null,
  _material: string | null,
  _industryContext: string | null,
  _targetUser: string | null,
): string | null {
  // Disabled — generated sentences were robotic and template-like.
  return null;
}

function deriveKnowledgeRelevance(_knowledge: ProductKnowledge): string | null {
  // Disabled — produced corporate-sounding sentences.
  return null;
}

function extractProductKnowledge(
  product: ShopifyCatalogItem,
  productClass: ProductClass,
): ProductKnowledge {
  const layers = buildTextLayers(product);
  const allText = layers.map(([t]) => t).concat(product.sku?.toLowerCase() ?? '').join(' ');
  const words   = allText.replace(/[-_/]/g, ' ').split(/\s+/).filter(Boolean);

  let industryContext: string | null = null;
  let hsnFallbackUsed = false;

  for (const [layerText] of layers) {
    if (!layerText) continue;
    for (const [kw, ind] of INDUSTRY_KEYWORDS) {
      if (layerText.includes(kw)) { industryContext = ind; break; }
    }
    if (industryContext) break;
  }

  if (!industryContext && product.hsnCode && productClass !== 'display') {
    const prefix = product.hsnCode.substring(0, 4);
    const mapped = HSN_INDUSTRY_MAP[prefix];
    if (mapped) { industryContext = mapped; hsnFallbackUsed = true; }
  }

  let primaryUse: string | null = null;
  for (const [layerText] of layers) {
    if (!layerText) continue;
    for (const [kw, use] of USE_KEYWORDS) {
      if (layerText.includes(kw)) { primaryUse = use; break; }
    }
    if (primaryUse) break;
  }

  let material: string | null = null;
  for (const kw of MATERIAL_KEYWORDS) {
    if (words.includes(kw)) { material = kw; break; }
  }

  const productType = deriveProductType(words);
  const targetUser  = industryContext ? (TARGET_USER_MAP[industryContext] ?? null) : null;
  const enrich      = buildEnrichSentence(productType, primaryUse, material, industryContext, targetUser);

  let confidence = 0;
  for (const [layerText, , bonus] of layers) {
    if (!layerText) continue;
    const hit =
      INDUSTRY_KEYWORDS.some(([kw]) => layerText.includes(kw)) ||
      USE_KEYWORDS.some(([kw]) => layerText.includes(kw));
    if (hit) confidence += bonus;
  }
  if (hsnFallbackUsed) confidence += 5;
  if (material)        confidence += 5;
  confidence = Math.min(Math.round(confidence), 100);

  return { productType, primaryUse, targetUser, material, industryContext, enrich, confidence };
}

// ══════════════════════════════════════════════════════════════════════════════
// SAFETY — banned phrases + forbidden patterns
// ══════════════════════════════════════════════════════════════════════════════

const FORBIDDEN_PATTERNS = [
  /quick\s+note/i,
  /sharing\s+(a\s+)?product/i,
  /from\s+our\s+catalog/i,
  /from\s+our\s+catalogue/i,
  /product\s+from\s+our\s+range/i,
  /commonly\s+used/i,
  /may\s+be\s+useful/i,
  /businesses?\s+usually/i,
  /limited\s+time/i,
  /last\s+chance/i,
  /hurry/i,
  /act\s+now/i,
  /don'?t\s+miss/i,
  /₹\s*\d/,
  /\bfree\b/i,
  /\bdiscount\b/i,
  /\boffer\b/i,
  /\bbuyers\b/i,
  /\bshowroom\b/i,
  /\bengagement\b/i,
  /\bvisibility\b/i,
  /improves?\s+sales/i,
  // Corporate language — banned
  /\bworkflow\b/i,
  /\boperational\b/i,
  /\befficiency\b/i,
  /clinical\s+decision/i,
  /\bsolutioning\b/i,
  /\becosystem\b/i,
  /process\s+optimization/i,
  /\bsuitable\s+for\s+(setups?|use|applications?)/i,
  /businesses?\s+handling/i,
  /glass\s+processing\s+units?/i,
  /textile\s+industr/i,
  /\bsimilar\s+requirements?\b/i,
];

const CATALOG_PATTERNS = [
  /this\s+is\s+a/i,
  /made\s+of/i,
  /available\s+in\s+(various|different|multiple)\s+(colors?|sizes?|variants?)/i,
  /perfect\s+for/i,
  /best\s+quality/i,
  /high\s+quality/i,
  /premium\s+quality/i,
  /\bon\s+sale\b/i,
  /buy\s+now/i,
  /order\s+now/i,
];

const STORE_BASE = 'https://www.heshstore.in';

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE QUALITY SCORING
//
// Target: 35–55 words preferred, 70 max
// Sentence: ≤12 words
// Paragraph: 1–2 lines
// Question: mandatory before CTA
// ══════════════════════════════════════════════════════════════════════════════

export interface MessageQualityScore {
  relevance:              number; // 0–10
  naturalLanguage:        number; // 0–10
  conversationPotential:  number; // 0–10
  businessValue:          number; // 0–10
  leadPotential:          number; // 0–10
  total:                  number; // average of five
  grade:                  'PASS' | 'REVIEW' | 'FAIL';
  flags:                  string[];
}

export function scoreMessage(result: PromotionGenerateResult): MessageQualityScore {
  const { message, metadata } = result;
  const flags: string[] = [];

  // ── Relevance ─────────────────────────────────────────────────────────────
  let relevance = 4;
  if (metadata.knowledgeConfidence >= 50)     relevance += 2;
  if (metadata.industryContext)               relevance += 2;
  if (metadata.contentCategory !== 'lead_starter') relevance += 2;
  relevance = Math.min(relevance, 10);

  // ── Natural Language ──────────────────────────────────────────────────────
  let naturalLanguage = 7;

  // Word count: 35–55 preferred, 70 max
  const wordCount = message.split(/\s+/).filter(Boolean).length;
  if (wordCount > 70)                          { naturalLanguage -= 3; flags.push('message_too_long'); }
  else if (wordCount > 55)                     { naturalLanguage -= 1; flags.push('message_approaching_limit'); }
  else if (wordCount >= 35 && wordCount <= 55) { naturalLanguage += 1; } // ideal range bonus

  // Sentence count bonus + sentence length penalty (max 12 words per sentence)
  // Structural lines (*product*, SKU:, 📞, 🛍, https://) are excluded so they don't merge
  // with adjacent content sentences and inflate the word count.
  const STRUCTURAL_LINE = /^(\*.*\*|SKU:|📞|🛍|https?:\/\/)/;
  const contentLines = message.split('\n').filter(l => l.trim() && !STRUCTURAL_LINE.test(l.trim()));
  const contentText = contentLines.join(' ');
  const sentences = contentText.split(/[.!?]\s+/).filter(Boolean);
  if (sentences.length >= 3 && sentences.length <= 12) naturalLanguage += 1;
  const longSentences = sentences.filter(s => s.split(/\s+/).filter(Boolean).length > 12).length;
  if (longSentences >= 2)       { naturalLanguage -= 2; flags.push('sentence_too_long'); }
  else if (longSentences === 1) { naturalLanguage -= 1; flags.push('sentence_too_long'); }

  // Paragraph length penalty (> 2 sentences in a single paragraph)
  const paragraphs = message.split(/\n\n+/).filter(p => p.trim());
  const longParagraphs = paragraphs.filter(p => {
    const pSentences = p.split(/[.!?]\s+/).filter(Boolean);
    return pSentences.length > 2;
  }).length;
  if (longParagraphs > 0) { naturalLanguage -= 1; flags.push('paragraph_too_long'); }

  // Explanation too long: any non-structural body paragraph with > 1 sentence
  const bodyParagraphs = paragraphs
    .slice(1) // skip hook (first paragraph)
    .filter(p => {
      const t = p.trim();
      return t.length > 0
        && !t.startsWith('*')
        && !t.startsWith('SKU:')
        && !t.startsWith('📞')
        && !t.startsWith('🛍')
        && !/^https?:\/\//i.test(t);
    });
  const hasExplanationTooLong = bodyParagraphs.some(p => (p.match(/[.!?]/g) ?? []).length > 1);
  if (hasExplanationTooLong) { naturalLanguage -= 1; flags.push('explanation_too_long'); }

  for (const p of CATALOG_PATTERNS) {
    if (p.test(message)) { naturalLanguage -= 2; flags.push(`catalog_pattern:${p.toString()}`); break; }
  }
  for (const p of FORBIDDEN_PATTERNS) {
    if (p.test(message)) { naturalLanguage -= 3; flags.push(`forbidden:${p.toString()}`); break; }
  }

  // ── Hook penalties ────────────────────────────────────────────────────────
  const hook      = metadata.notificationHook ?? '';
  const hookFlags = metadata.hookValidationFlags ?? [];
  if (!hook || hook.trim() === '') {
    naturalLanguage -= 3; flags.push('missing_hook');
  } else {
    if (hookFlags.includes('hook_too_long'))          { naturalLanguage -= 1; flags.push('hook_too_long'); }
    if (hookFlags.includes('hook_contains_product'))  { naturalLanguage -= 2; flags.push('hook_contains_product'); }
    if (hookFlags.includes('hook_contains_greeting')) { naturalLanguage -= 2; flags.push('hook_contains_greeting'); }
    if (hookFlags.includes('weak_hook'))              { naturalLanguage -= 1; flags.push('weak_hook'); }
  }
  naturalLanguage = Math.max(0, Math.min(naturalLanguage, 10));

  // ── Conversation Potential — question is mandatory before CTA ─────────────
  let conversationPotential = 4;
  const hasCallCta = /📞/.test(message);
  const hasTrigger = /\?/.test(message);
  if (hasCallCta)  conversationPotential += 2;
  if (hasTrigger)  conversationPotential += 4;
  if (!hasTrigger) { flags.push('missing_question'); conversationPotential -= 2; }
  conversationPotential = Math.min(Math.max(0, conversationPotential), 10);

  // ── Business Value ────────────────────────────────────────────────────────
  let businessValue = 4;
  if (['problem_based', 'workflow_based'].includes(metadata.contentCategory)) businessValue += 2;
  if (metadata.industryContext)           businessValue += 2;
  if (metadata.knowledgeConfidence >= 65) businessValue += 2;
  businessValue = Math.min(businessValue, 10);

  // ── Lead Generation Potential ─────────────────────────────────────────────
  let leadPotential = 4;
  if (hasCallCta)         leadPotential += 2;
  if (/🛍/.test(message)) leadPotential += 2;
  if (hasTrigger)         leadPotential += 2;
  leadPotential = Math.min(leadPotential, 10);

  const total = parseFloat(
    ((relevance + naturalLanguage + conversationPotential + businessValue + leadPotential) / 5).toFixed(1),
  );

  const hasForbidden = flags.some(f => f.startsWith('forbidden') || f.startsWith('catalog'));
  const grade: MessageQualityScore['grade'] =
    total >= 7.5 && !hasForbidden ? 'PASS' : total >= 5.0 ? 'REVIEW' : 'FAIL';

  return { relevance, naturalLanguage, conversationPotential, businessValue, leadPotential, total, grade, flags };
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ══════════════════════════════════════════════════════════════════════════════

const MAX_REGENERATION_ATTEMPTS = 3;
const QUALITY_THRESHOLD         = 7.0;

@Injectable()
export class PromotionAiTemplateService {
  private readonly logger = new Logger(PromotionAiTemplateService.name);
  private _hookHistory = new Map<string, string[]>();

  constructor(
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
  ) {}

  async generate(input: PromotionGenerateInput): Promise<PromotionGenerateResult> {
    const { product, customer, telecaller_phone, offer } = input;

    const productName  = product.itemName ?? product.sku ?? 'this product';
    const sku          = product.sku ?? '';
    const productClass = classifyProduct(product);
    const pools        = POOL_MAP[productClass];
    const knowledge    = extractProductKnowledge(product, productClass);
    const context      = deriveBusinessContext(productClass, knowledge);

    const { productUrl, urlSource } = this._buildProductUrl(product);

    // Reject immediately — no handle and no SKU means no safe URL can be built
    if (urlSource === 'rejected') {
      this.logger.warn(
        `[PRODUCT_URL_REJECT] sku="${sku}" itemName="${product.itemName ?? ''}" id=${product.id} ` +
        `— product skipped: no Shopify handle and no SKU`,
      );
      return {
        message:      '',
        imageUrl:     null,
        productUrl:   '',
        qualityPassed: false,
        quality:      { finalScore: 0, attemptsUsed: 0, grade: 'FAIL' },
        metadata: {
          templateVariant:     'rejected',
          contentCategory:     'lead_starter',
          hookType:            'none',
          messageLength:       0,
          productSku:          sku,
          productClass,
          industryContext:     null,
          knowledgeConfidence: 0,
          businessProblem:     '',
          urlSource:           'rejected',
          notificationHook:    '',
          hookValidationFlags: [],
        },
      };
    }

    const imageUrl  = product.image || null;
    const offerLine = offer?.text
      ? (offer.title ? `${offer.title}: ${offer.text}` : offer.text)
      : undefined;

    let result: PromotionGenerateResult | null = null;
    let lastScore: ReturnType<typeof scoreMessage> | null = null;

    for (let attempt = 0; attempt < MAX_REGENERATION_ATTEMPTS; attempt++) {
      const category  = this._pickCategory();
      const callLabel = this._pickRandom(CALL_LABELS);

      const block = this._categoryBlock(category, pools);
      const hook  = this._pickHook(productClass, customer.phone);
      const hookValidationFlags = this._validateHook(hook, productName, sku);

      if (hookValidationFlags.length > 0) {
        this.logger.warn(
          `[PROMO_AI_HOOK] hook_flags=${hookValidationFlags.join(',')} sku=${sku} hook="${hook.slice(0, 60)}"`,
        );
      }

      const message = this._buildMessage({
        hook, productName, sku,
        pain: block.pain, benefit: block.benefit, trigger: block.trigger,
        callLabel, telecallerPhone: telecaller_phone, productUrl, offerLine,
      });

      result = {
        message,
        imageUrl,
        productUrl,
        qualityPassed: false,
        quality: { finalScore: 0, attemptsUsed: attempt + 1, grade: 'FAIL' },
        metadata: {
          templateVariant:     `v${attempt + 1}`,
          contentCategory:     category,
          hookType:            category,
          messageLength:       message.length,
          productSku:          sku,
          productClass,
          industryContext:     knowledge.industryContext ?? null,
          knowledgeConfidence: knowledge.confidence,
          businessProblem:     context.businessProblem,
          urlSource,
          notificationHook:    hook,
          hookValidationFlags,
        },
      };

      lastScore = scoreMessage(result);
      result.quality = { finalScore: lastScore.total, attemptsUsed: attempt + 1, grade: lastScore.grade };

      if (lastScore.total >= QUALITY_THRESHOLD && !lastScore.flags.some(f => f.startsWith('forbidden'))) {
        result.qualityPassed = true;
        this.logger.log(
          `[PROMO_AI] attempt=${attempt + 1} grade=${lastScore.grade} score=${lastScore.total} ` +
          `category=${category} class=${productClass} confidence=${knowledge.confidence} sku=${sku}`,
        );
        this._assertSafe(message);
        return result;
      }

      this.logger.warn(
        `[PROMO_AI_REGEN] attempt=${attempt + 1} score=${lastScore.total} flags=${lastScore.flags.join(',')} ` +
        `category=${category} sku=${sku}`,
      );
    }

    // All attempts exhausted — return with qualityPassed=false so sender can reject
    this._assertSafe(result!.message);
    this.logger.warn(
      `[PROMO_AI_QUALITY_FAIL] sku=${sku} finalScore=${lastScore?.total ?? 0} ` +
      `attempts=${MAX_REGENERATION_ATTEMPTS} — quality gate not passed`,
    );
    return result!;
  }

  // ── Validation report — 100 synthetic samples measuring reply potential ───────

  async generateValidationReport(sampleCount = 100): Promise<{
    avgWordCount:         number;
    avgSentenceLength:    number;
    avgReplyPotential:    number;
    passRate:             number;
    flagDistribution:     Record<string, number>;
    rejectionBreakdown:   {
      weakHooks:          number;
      missingQuestions:   number;
      longMessages:       number;
      corporateLanguage:  number;
    };
  }> {
    const testProducts = [
      { id: 1, itemName: 'Frame Display Wall Panel', sku: 'DP001', productType: 'display', description: 'optical frame display wall panel', handle: 'frame-display-wall-panel', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
      { id: 2, itemName: 'Auto Refractometer', sku: 'MR001', productType: 'optical instrument', description: 'auto refractometer optical instrument', handle: 'auto-refractometer', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
      { id: 3, itemName: 'EVA Spectacle Case', sku: 'EC001', productType: 'spectacle case', description: 'eva spectacle case optical', handle: 'eva-spectacle-case', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
      { id: 4, itemName: 'Lens Cleaning Spray 100ml', sku: 'LC001', productType: 'lens cleaner', description: 'optical lens cleaning spray', handle: 'lens-cleaning-spray', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
      { id: 5, itemName: 'Optical Microfiber Cloth', sku: 'MC001', productType: 'microfiber cloth', description: 'optical microfiber cleaning cloth', handle: 'optical-microfiber-cloth', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
      { id: 6, itemName: 'Optical Screwdriver Set', sku: 'TS001', productType: 'optical tool', description: 'optical screwdriver fitting tool', handle: 'optical-screwdriver-set', image: 'https://cdn.shopify.com/test.jpg', syncIgnored: false },
    ] as unknown as ShopifyCatalogItem[];

    const results: PromotionGenerateResult[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const product = testProducts[i % testProducts.length];
      const result  = await this.generate({
        telecaller_number_id: 'validation',
        telecaller_phone:     '+919999999999',
        product,
        customer: { name: 'Rajesh', city: 'Mumbai', business_type: 'optical_store' },
      });
      results.push(result);
    }

    const totalWords = results.reduce(
      (sum, r) => sum + r.message.split(/\s+/).filter(Boolean).length, 0,
    );
    const avgWordCount = parseFloat((totalWords / results.length).toFixed(1));

    const allSentences = results.flatMap(r => r.message.split(/[.!?]\s+/).filter(Boolean));
    const totalSentenceWords = allSentences.reduce(
      (sum, s) => sum + s.split(/\s+/).filter(Boolean).length, 0,
    );
    const avgSentenceLength = parseFloat((totalSentenceWords / allSentences.length).toFixed(1));

    const scores = results.map(r => scoreMessage(r));
    const avgReplyPotential = parseFloat(
      (scores.reduce((sum, s) => sum + s.conversationPotential, 0) / scores.length).toFixed(1),
    );
    const passRate = parseFloat(
      ((scores.filter(s => s.grade === 'PASS').length / scores.length) * 100).toFixed(1),
    );

    const flagDistribution: Record<string, number> = {};
    for (const s of scores) {
      for (const flag of s.flags) {
        flagDistribution[flag] = (flagDistribution[flag] ?? 0) + 1;
      }
    }

    const rejectionBreakdown = {
      weakHooks:         scores.filter(s => s.flags.includes('weak_hook')).length,
      missingQuestions:  scores.filter(s => s.flags.includes('missing_question')).length,
      longMessages:      scores.filter(s => s.flags.includes('message_too_long')).length,
      corporateLanguage: scores.filter(s => s.flags.some(f => f.startsWith('forbidden:'))).length,
    };

    this.logger.log(
      `[PROMO_VALIDATION] samples=${results.length} avgWords=${avgWordCount} ` +
      `avgSentLen=${avgSentenceLength} replyPotential=${avgReplyPotential} passRate=${passRate}% ` +
      `rejected_weakHook=${rejectionBreakdown.weakHooks} ` +
      `rejected_noQuestion=${rejectionBreakdown.missingQuestions} ` +
      `rejected_tooLong=${rejectionBreakdown.longMessages} ` +
      `rejected_corporate=${rejectionBreakdown.corporateLanguage}`,
    );

    return { avgWordCount, avgSentenceLength, avgReplyPotential, passRate, flagDistribution, rejectionBreakdown };
  }

  // ── Category selection ────────────────────────────────────────────────────────

  private _pickCategory(): ContentCategory {
    const r = Math.random() * 100;
    for (const [cat, threshold] of CATEGORY_THRESHOLDS) {
      if (r < threshold) return cat;
    }
    return 'lead_starter';
  }

  // ── Block selection ───────────────────────────────────────────────────────────

  private _categoryBlock(category: ContentCategory, pools: ProductClassPools): ContentBlock {
    return this._pickRandom(pools[category]);
  }

  // ── Message assembly ──────────────────────────────────────────────────────────
  // Final structure: hook → pain → *product* → benefit → trigger → 🛍 CTA → 📞 CTA
  // Word target: 35–55 preferred, 70 max.

  private _buildMessage(parts: {
    hook:            string;
    productName:     string;
    sku:             string;
    pain:            string;
    benefit:         string;
    trigger:         string;
    callLabel:       string;
    telecallerPhone: string;
    productUrl:      string;
    offerLine?:      string;
  }): string {
    const {
      hook, productName, sku,
      pain, benefit, trigger,
      callLabel, telecallerPhone, productUrl, offerLine,
    } = parts;

    const lines: string[] = [
      hook, ``,
      pain, ``,
      `*${productName}*`,
      `SKU: ${sku}`, ``,
      benefit, ``,
      trigger,
    ];

    if (offerLine) lines.push(``, offerLine);

    lines.push(
      ``,
      buildCta({ type: 'product', url: productUrl }), ``,
      buildCta({ type: 'call', phone: telecallerPhone, callLabel }),
    );

    return lines.join('\n');
  }

  // ── Product URL ───────────────────────────────────────────────────────────────
  //
  // Only two valid sources:
  //   handle  → /products/{handle}   (Shopify-synced, guaranteed correct)
  //   search  → /search?q={sku}      (SKU fallback when handle is missing)
  //   rejected → product must be skipped — no slug generation, no guessing
  //
  // Name-derived slugs and AI-generated slugs are BANNED — they can produce
  // URLs that resolve to the wrong product page.

  private _buildProductUrl(
    product: ShopifyCatalogItem,
  ): { productUrl: string; urlSource: 'handle' | 'search' | 'rejected' } {
    const handle = product.handle?.trim() ?? '';
    const sku    = product.sku?.trim() ?? '';

    if (handle && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(handle)) {
      this.logger.log(
        `[PRODUCT_URL_HANDLE] sku=${sku} handle=${handle} → ${STORE_BASE}/products/${handle}`,
      );
      return { productUrl: `${STORE_BASE}/products/${handle}`, urlSource: 'handle' };
    }

    if (sku) {
      const searchUrl = `${STORE_BASE}/search?q=${encodeURIComponent(sku)}`;
      this.logger.warn(
        `[PRODUCT_URL_SEARCH] sku=${sku} handle="${handle || 'missing'}" → ${searchUrl}`,
      );
      return { productUrl: searchUrl, urlSource: 'search' };
    }

    // No handle and no SKU — caller must reject this product
    return { productUrl: '', urlSource: 'rejected' };
  }

  // ── Pickers ───────────────────────────────────────────────────────────────────

  private _pickHook(productClass: ProductClass, phone?: string): string {
    const pool = HOOK_POOLS[productClass];
    return this._pickFromPool(pool as readonly string[], this._hookHistory, phone);
  }

  private _validateHook(hook: string, productName: string, sku: string): string[] {
    const f: string[] = [];
    if (!hook || hook.trim() === '') return ['missing_hook'];

    if (hook.length > 80) f.push('hook_too_long');
    if (/\b(hi|hello|dear|greetings|namaste)\b/i.test(hook)) f.push('hook_contains_greeting');
    if (/https?:\/\/|www\./i.test(hook)) f.push('hook_contains_url');
    if (/\+?\d{10,}/.test(hook)) f.push('hook_contains_phone');
    if (/\p{Emoji_Presentation}/u.test(hook)) f.push('hook_contains_emoji');
    if (/\b(hesh|heshstore)\b/i.test(hook)) f.push('hook_contains_company');

    const hookLower = hook.toLowerCase();
    if (sku && sku.length > 2 && hookLower.includes(sku.toLowerCase())) {
      f.push('hook_contains_product');
    }
    if (productName && productName !== 'this product' && productName.length > 6) {
      if (hookLower.includes(productName.toLowerCase())) f.push('hook_contains_product');
    }

    if (hook.trim().length < 40) f.push('weak_hook');

    return f;
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

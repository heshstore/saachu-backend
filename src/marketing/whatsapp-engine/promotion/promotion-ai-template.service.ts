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
    templateVariant:     string;
    contentCategory:     ContentCategory;
    softCtaUsed:         string;
    hookType:            string;
    messageLength:       number;
    productSku:          string;
    productClass:        ProductClass;
    industryContext:     string | null;
    knowledgeConfidence: number;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════════════

type ProductClass = 'display' | 'machine' | 'consumable' | 'component' | 'general';

const DISPLAY_TERMS    = /display|panel|holder|rack|counter|wall|peg|shelf|stand|fixture|mount|grid|hook/i;
const MACHINE_TERMS    = /machine|wheel|tool|blade|motor|cutter|press|drill|grinder|lathe|pump|conveyor/i;
const CONSUMABLE_TERMS = /solution|liquid|cleaner|chemical|consumable|pad|lubric|solvent|spray|gel|powder/i;
const COMPONENT_TERMS  = /component|part|accessory|connector|fitting|bracket|bolt|screw|clip|pin/i;

function classifyProduct(product: ShopifyCatalogItem): ProductClass {
  const text = [product.itemName, product.sku].filter(Boolean).join(' ');
  // Unit-based consumable signal — liquids and weights are consumables even when name doesn't say so
  const unit = product.unit?.trim().toLowerCase() ?? '';
  if (/^(l|ml|ltr|litre|liter|kg|g|gram|gm)$/.test(unit)) return 'consumable';
  if (DISPLAY_TERMS.test(text))    return 'display';
  if (MACHINE_TERMS.test(text))    return 'machine';
  if (CONSUMABLE_TERMS.test(text)) return 'consumable';
  if (COMPONENT_TERMS.test(text))  return 'component';
  return 'general';
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT CATEGORIES & WEIGHTS
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ROTATION POOLS
// ══════════════════════════════════════════════════════════════════════════════

const GREETINGS: ((name: string) => string)[] = [
  (n) => `Hi ${n},`,
  (n) => `Hello ${n},`,
  (n) => `Hi ${n}.`,
  (n) => `Hello ${n}.`,
];

const CALL_LABELS = ['Call us', 'Reach us', 'Contact us', 'Talk to us'];

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

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT CLASS POOL TYPE
// ══════════════════════════════════════════════════════════════════════════════

interface ProductClassPools {
  ed_hooks:    ((city: string) => string)[];
  ed_explains: string[];
  ed_benefits: string[];
  ps_blocks:   { problem: string; solution: string; outcome: string }[];
  pi_hooks:    string[];
  pi_explains: string[];
  pi_benefits: string[];
  bn_hooks:    ((city: string) => string)[];
  bn_explains: string[];
  bn_benefits: string[];
  sp_blocks:   { hook: string; note: string; benefit: string }[];
  dp_blocks:   { hook: string; detail: string; benefit: string }[];
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPLAY PRODUCTS — panels, holders, racks, stands, wall fixtures
// ══════════════════════════════════════════════════════════════════════════════

const DISPLAY_POOLS: ProductClassPools = {

  ed_hooks: [
    (_) => `Products become harder to manage when a range expands without a clear system in place.`,
    (_) => `When products are grouped without separation, buyers often overlook items they were looking for.`,
    (city) => city
      ? `Managing a wide product range in ${city} usually comes down to how well each item is positioned and accessible.`
      : `Managing a wide product range usually comes down to how well each item is positioned and accessible.`,
    (_) => `A small change in how products are arranged can make a noticeable difference in how many items get examined.`,
    (city) => city
      ? `Buyers visiting stores in ${city} with a large range move quickly through areas where products are clearly separated.`
      : `Buyers with a short list move quickly through ranges where each product is easy to find and pick up.`,
  ],

  ed_explains: [
    `A display fixture for individual product placement. Keeps each item separated and accessible without stacking.`,
    `Used in showroom and retail environments where products need clear, defined positions — no custom installation needed.`,
    `A modular holder for organizing products individually. Each item gets its own slot in the layout.`,
    `Designed for product separation in shared spaces. Easy to set up and adjust as the range changes.`,
  ],

  ed_benefits: [
    `Reduces time spent rearranging products during the day.`,
    `Each product is accessible without disturbing others in the same space.`,
    `Suitable for setups where multiple products share limited wall or counter space.`,
    `Simplifies daily restocking — each item returns to a defined position.`,
  ],

  ps_blocks: [
    {
      problem: `Products placed without separation are harder to pick up and examine individually.\nBuyers often skip past grouped items — even ones they were looking for.`,
      solution: `Holds each item in a fixed, individual slot. Products are accessible one at a time without moving others.`,
      outcome: `Each product can be examined without disturbing the rest of the arrangement.`,
    },
    {
      problem: `Display setups that shift or tilt under regular use create extra effort to reset.\nThis happens more often when fixtures are not built for the load they carry.`,
      solution: `Holds position under regular handling and restocking without needing constant readjustment.`,
      outcome: `Reduces the effort required to maintain a consistent arrangement across the day.`,
    },
    {
      problem: `Adding new products to an existing display often means rearranging the whole layout.\nThis happens repeatedly as ranges grow.`,
      solution: `Modular design — new items slot in alongside existing ones without disrupting the current setup.`,
      outcome: `Range can grow without reorganizing what is already in place.`,
    },
    {
      problem: `Buyers visiting multiple branches expect consistent product placement at each location.\nWhen layouts differ, it is harder for them to locate items independently.`,
      solution: `Standardized fixture that sets up the same way across different locations without customization.`,
      outcome: `Consistent product placement across branches.`,
    },
  ],

  pi_hooks: [
    `Quick note on something from our display range — might be relevant to your current setup.`,
    `Sharing a fixture from our catalog that tends to suit businesses organizing a wide product range.`,
    `One item worth knowing about if you are looking at how products are arranged in your space.`,
    `Something from our display range that covers a common product organization requirement.`,
  ],

  pi_explains: [
    `A display holder for organized, individual product placement. Works with most standard wall and counter configurations.`,
    `Used in retail and showroom settings where each product needs a defined, accessible position — no installation required.`,
    `Lightweight, modular fixture. Easy to adjust as the product range changes.`,
    `A holder that keeps products separated and accessible. Suitable for both wall and countertop use.`,
  ],

  pi_benefits: [
    `Standard configuration. No custom installation required.`,
    `Durable under daily handling. Minimal ongoing maintenance.`,
    `Easy to adjust as the product range changes.`,
  ],

  bn_hooks: [
    (_) => `Products that are easy to pick up and examine get more attention than ones that require assistance.`,
    (_) => `When each product has its own accessible position, buyers can move through a range at their own pace.`,
    (city) => city
      ? `For businesses in ${city} managing a growing product range, individual product access is usually the first thing that needs attention.`
      : `For businesses managing a growing product range, individual product access is usually the first thing that needs attention.`,
    (_) => `Organized product placement reduces the need for staff to guide buyers through the range.`,
  ],

  bn_explains: [
    `Keeps each product in a fixed, accessible position. Items can be examined individually without moving others.`,
    `Separates products in a shared space so each one is reachable without disrupting the arrangement.`,
    `Gives every item a defined slot — easy to access, easy to restock.`,
  ],

  bn_benefits: [
    `Useful when multiple products share limited space and each needs to be individually accessible.`,
    `Reduces the need for buyers to ask staff for help locating items.`,
    `Simplifies daily restocking — products return to the same position each time.`,
    `Helpful when the product range is large and every item needs to be reachable.`,
  ],

  sp_blocks: [
    {
      hook: `A frequently requested item among businesses organizing product placement in retail and showroom environments.`,
      note: `Commonly chosen for its straightforward installation and consistent results across different configurations.`,
      benefit: `Practical across different wall and counter setups. Low ongoing maintenance.`,
    },
    {
      hook: `One of our more consistently ordered display fixtures among businesses managing a wide product range.`,
      note: `Often selected when businesses want individual product slots without complex installation or custom fitting.`,
      benefit: `Works immediately once set up. Easy to expand as the range grows.`,
    },
    {
      hook: `A display item that is commonly added to subsequent orders as product ranges grow.`,
      note: `Used in retail and showroom setups where organized, individual product placement is the goal.`,
      benefit: `Each addition fits alongside the existing setup without modification.`,
    },
  ],

  dp_blocks: [
    {
      hook: `Sharing something from our display range — might be relevant to your product placement needs.`,
      detail: `A fixture for organized, individual product display. In stock. Standard configurations available.`,
      benefit: `Fits most wall and counter setups. No special installation required.`,
    },
    {
      hook: `Quick note on a display item from our catalog.`,
      detail: `Used for organized product placement in retail and showroom environments. Easy to set up.`,
      benefit: `Low maintenance. Works across different layout sizes.`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// MACHINE PRODUCTS — machines, tools, wheels, blades, motors, cutters
// ══════════════════════════════════════════════════════════════════════════════

const MACHINE_POOLS: ProductClassPools = {

  ed_hooks: [
    (_) => `Equipment problems that start small tend to affect output before they are identified.`,
    (_) => `Using general-purpose equipment for a specialized task usually creates more maintenance work than expected.`,
    (city) => city
      ? `Production businesses in ${city} often find that unplanned equipment downtime traces back to a small operational issue.`
      : `Unplanned equipment downtime often traces back to a small operational issue that was straightforward to address.`,
    (_) => `The right tool matched to a specific task reduces wear on surrounding equipment over time.`,
    (_) => `Operational consistency is easier to maintain when equipment is built for the task it performs.`,
  ],

  ed_explains: [
    `A machine designed for production or processing use. Built for operational settings where consistent output is needed.`,
    `Used in manufacturing, fabrication, or processing environments. Handles regular workloads without frequent servicing.`,
    `A tool for a specific production task. Designed to perform consistently under regular operational use.`,
    `Industrial equipment for day-to-day production work. Standard configuration available — no complex setup required.`,
  ],

  ed_benefits: [
    `Reduces variance in output when used for the task it is designed for.`,
    `Designed for consistent performance across repeated use cycles.`,
    `Useful where a dedicated tool removes the need for workarounds in the production process.`,
    `Suitable for settings where equipment reliability directly affects daily operational output.`,
  ],

  ps_blocks: [
    {
      problem: `Using general-purpose equipment for a specialized task increases wear and reduces output quality.\nA tool built for the purpose is usually more reliable over time.`,
      solution: `Designed specifically for the task — not adapted from a general-purpose alternative.`,
      outcome: `More consistent output. Reduced wear on surrounding equipment.`,
    },
    {
      problem: `Equipment that requires frequent mid-run adjustments slows the overall production process.\nOperators spend time correcting rather than producing.`,
      solution: `Maintains its settings under regular operational use. Fewer corrections needed during a production run.`,
      outcome: `Fewer interruptions during the production cycle.`,
    },
    {
      problem: `When production equipment is shared between tasks, setup time adds up across the day.\nDedicated tooling reduces this significantly.`,
      solution: `Configured for a specific operational purpose. No setup changes required between tasks.`,
      outcome: `Less time setting up. More time on actual production.`,
    },
    {
      problem: `Low-quality tooling produces inconsistent results that require rework or material waste.\nThis cost compounds across a production run.`,
      solution: `Consistent performance across production cycles — reduces rework and material waste per cycle.`,
      outcome: `Fewer corrections needed. More predictable cost per unit over time.`,
    },
  ],

  pi_hooks: [
    `Quick note on a machine from our catalog — might be relevant depending on your production setup.`,
    `Sharing a tool from our range that tends to come up with businesses running similar operations.`,
    `One item worth knowing about if you are looking to supplement or replace current production equipment.`,
    `Something from our production range that covers a common operational requirement.`,
  ],

  pi_explains: [
    `A machine for production or processing work. Designed for operational environments where consistent output matters.`,
    `Used in manufacturing and fabrication settings. Handles regular workloads without requiring frequent servicing.`,
    `A tool for production use. Straightforward to integrate into an existing workflow.`,
    `Industrial equipment suited for day-to-day production tasks. Standard configuration — operational from day one.`,
  ],

  pi_benefits: [
    `Standard configuration. No complex installation required.`,
    `Designed for regular use. Minimal adjustment needed once set up.`,
    `Integrates with most standard production workflows.`,
  ],

  bn_hooks: [
    (_) => `Production output is easier to keep consistent when the right tool is matched to the specific task.`,
    (_) => `Equipment built for a purpose requires less maintenance than a general-purpose alternative used beyond its range.`,
    (city) => city
      ? `Businesses in ${city} running regular production often find that dedicated tooling reduces per-unit handling time.`
      : `Dedicated tooling for a specific task reduces per-unit handling time compared to adapted alternatives.`,
    (_) => `When a production process requires consistent results, the choice of equipment matters more than it appears.`,
  ],

  bn_explains: [
    `Handles the specific task it is designed for — reduces the need for mid-run adjustments.`,
    `Purpose-built for operational use. Performs consistently without requiring workarounds.`,
    `Designed for the task. Reduces setup time and mid-run corrections across production cycles.`,
  ],

  bn_benefits: [
    `Reduces setup time at the start of each production run.`,
    `Useful when consistent output matters more than versatility.`,
    `Simplifies the production process where a dedicated tool replaces a general-purpose workaround.`,
    `Suitable for repeated use in regular production cycles without performance degradation.`,
  ],

  sp_blocks: [
    {
      hook: `A frequently requested item among businesses running similar production operations.`,
      note: `Usually chosen when businesses need reliable, consistent performance without complex setup.`,
      benefit: `Holds up under regular production use. Low ongoing maintenance.`,
    },
    {
      hook: `One of our more consistently ordered machines among businesses in manufacturing and processing.`,
      note: `Often selected when a dedicated tool is needed rather than adapting general equipment for the task.`,
      benefit: `Operational from day one. Minimal adjustment required.`,
    },
    {
      hook: `A machine that is commonly added to the standard production setup once in use.`,
      note: `Used across a range of production environments where consistent output is the priority.`,
      benefit: `Predictable performance across repeated production cycles.`,
    },
  ],

  dp_blocks: [
    {
      hook: `Sharing something from our production equipment range — might be relevant to your current setup.`,
      detail: `A machine for production or processing use. In stock. Standard and custom configurations available.`,
      benefit: `Designed for operational use. No complex installation required.`,
    },
    {
      hook: `Quick note on a machine from our catalog.`,
      detail: `Used in manufacturing and processing environments for consistent production output. Easy to integrate.`,
      benefit: `Reliable performance. Low ongoing maintenance.`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSUMABLE PRODUCTS — solutions, cleaners, pads, chemicals, lubricants
// ══════════════════════════════════════════════════════════════════════════════

const CONSUMABLE_POOLS: ProductClassPools = {

  ed_hooks: [
    (_) => `Consumable items that run out unexpectedly create delays that are straightforward to prevent.`,
    (_) => `Maintenance products are often overlooked until they affect output — usually at the wrong time.`,
    (city) => city
      ? `Businesses in ${city} running regular operations tend to manage consumables proactively rather than reactively.`
      : `Businesses running regular operations tend to manage consumables proactively rather than reactively.`,
    (_) => `Using the wrong maintenance product for a specific surface often creates more work than it saves.`,
    (_) => `Consistent consumable quality reduces variation in results across different maintenance cycles.`,
  ],

  ed_explains: [
    `A maintenance or cleaning product for regular operational use. Consistent formulation across every unit.`,
    `Used in production, cleaning, or maintenance workflows where a reliable consumable is needed.`,
    `A consumable designed for repeated application. Suitable for day-to-day maintenance tasks.`,
    `A product for routine surface treatment or cleaning. No specialist equipment required for application.`,
  ],

  ed_benefits: [
    `Consistent results across every application — reduces variation between maintenance cycles.`,
    `Simplifies regular maintenance with a reliable consumable for recurring tasks.`,
    `Suitable for regular use without concern about surface damage or residue buildup.`,
    `Useful when a maintenance task needs a dedicated product rather than a general alternative.`,
  ],

  ps_blocks: [
    {
      problem: `Running out of a maintenance consumable mid-operation creates unplanned downtime.\nMost businesses only notice the gap once the disruption has started.`,
      solution: `Available in quantities suited for regular replenishment cycles. Easy to order in advance.`,
      outcome: `Reduces the risk of supply gaps disrupting the operational schedule.`,
    },
    {
      problem: `Using the wrong cleaning product damages surfaces or leaves residue that creates additional work.\nThis is common when a general alternative is used for a task that needs a specific product.`,
      solution: `Formulated for the specific surface or task — does not damage materials it is designed to clean.`,
      outcome: `Consistent cleaning result without secondary damage or residue.`,
    },
    {
      problem: `Inconsistent consumable quality produces varying results across batches.\nThis creates additional correction work to compensate.`,
      solution: `Consistent formulation across every unit. Same result on every application.`,
      outcome: `Predictable performance. Reduces rework caused by inconsistent results.`,
    },
    {
      problem: `Maintenance products that leave residue create additional cleaning work after application.\nThe secondary step adds time to every maintenance cycle.`,
      solution: `Clean application — no residue left on the treated surface.`,
      outcome: `Reduces total time spent on each maintenance cycle.`,
    },
  ],

  pi_hooks: [
    `Quick note on a consumable from our range — relevant if this type of product is part of your regular routine.`,
    `Sharing a maintenance product from our catalog that tends to come up with businesses running similar operations.`,
    `One item worth knowing about if you are looking for a reliable consumable for regular use.`,
    `Something from our catalog that covers a common maintenance or cleaning requirement.`,
  ],

  pi_explains: [
    `A cleaning or maintenance product for regular use. Consistent formulation. No specialist equipment needed.`,
    `Used in operational settings where a reliable consumable is needed for recurring maintenance tasks.`,
    `A product for routine surface treatment or cleaning. Suitable for repeated application on standard materials.`,
    `Formulated for consistent results across multiple applications. Works on compatible surfaces.`,
  ],

  pi_benefits: [
    `Consistent results across every application. No variation between batches.`,
    `Suitable for regular use. No surface damage under correct application.`,
    `Available in quantities suited for regular replenishment.`,
  ],

  bn_hooks: [
    (_) => `Maintenance consumables deliver the best results when matched to the specific surface or task.`,
    (_) => `A dedicated product for a maintenance task is more reliable than a general alternative over repeated use.`,
    (city) => city
      ? `Businesses in ${city} with regular maintenance schedules find fewer disruptions when consumables are managed proactively.`
      : `Businesses with regular maintenance schedules find fewer disruptions when consumables are managed proactively.`,
    (_) => `Surface condition and equipment life are often determined by which maintenance product is used consistently.`,
  ],

  bn_explains: [
    `A dedicated consumable for the task — removes the inconsistency of general-purpose alternatives.`,
    `Designed for regular application. Consistent result every time it is used.`,
    `Suited for the specific maintenance task — reduces correction work from inconsistent results.`,
  ],

  bn_benefits: [
    `Reduces variation in results across different maintenance cycles.`,
    `Simplifies procurement — one reliable product for a recurring task.`,
    `Useful when consistency matters more than finding the lowest-cost alternative.`,
    `Easier to plan replenishment when consumption is predictable.`,
  ],

  sp_blocks: [
    {
      hook: `A frequently reordered consumable among businesses managing regular maintenance schedules.`,
      note: `Commonly chosen for its consistent results and compatibility with a range of standard materials.`,
      benefit: `Reliable across repeated applications. Easy to incorporate into existing routines.`,
    },
    {
      hook: `One of our more consistently ordered maintenance products among businesses in this segment.`,
      note: `Often selected when businesses want a reliable product for a recurring maintenance task.`,
      benefit: `Consistent formulation. Same result every time.`,
    },
    {
      hook: `A consumable that is commonly added to regular orders once businesses incorporate it into their routine.`,
      note: `Used in settings where a dependable maintenance product simplifies the recurring task.`,
      benefit: `Reduces time spent sourcing alternatives. Predictable performance.`,
    },
  ],

  dp_blocks: [
    {
      hook: `Sharing something from our consumables range — relevant if this is part of your regular maintenance.`,
      detail: `A cleaning or maintenance product for repeated use. In stock. Available in standard pack sizes.`,
      benefit: `Consistent results. No specialist equipment needed.`,
    },
    {
      hook: `Quick note on a consumable from our catalog.`,
      detail: `Used in maintenance and cleaning workflows where a reliable consumable is needed regularly.`,
      benefit: `Predictable performance. Easy to incorporate into an existing routine.`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// COMPONENT PRODUCTS — parts, accessories, connectors, brackets, fittings
// ══════════════════════════════════════════════════════════════════════════════

const COMPONENT_POOLS: ProductClassPools = {

  ed_hooks: [
    (_) => `Small components often create the largest disruptions when they are missing or out of stock.`,
    (_) => `Having the right part available when needed reduces equipment repair time significantly.`,
    (city) => city
      ? `Businesses in ${city} managing their own equipment often find that component sourcing is where delays actually start.`
      : `Businesses managing their own equipment often find that component sourcing is where delays actually start.`,
    (_) => `Equipment with standardized components is easier to maintain than setups that require unique parts.`,
    (_) => `Sourcing common parts proactively is usually less costly than sourcing them under urgency.`,
  ],

  ed_explains: [
    `A replacement or add-on component for equipment maintenance and repair. Compatible with standard configurations.`,
    `Used to maintain, repair, or extend the function of existing equipment. No custom modification required.`,
    `A spare or accessory part for regular replacement cycles. Straightforward to install.`,
    `A component for integration into existing systems. Works with standard equipment in this category.`,
  ],

  ed_benefits: [
    `Reduces repair downtime when kept as a planned stock item.`,
    `Compatible with standard equipment — no custom modification needed.`,
    `Simplifies maintenance planning when the component has a predictable replacement cycle.`,
    `Reduces sourcing time when procured proactively rather than reactively.`,
  ],

  ps_blocks: [
    {
      problem: `Equipment downtime caused by a missing component is usually avoidable.\nBusinesses that stock common parts rarely face extended delays for straightforward repairs.`,
      solution: `A stock item suitable for preventive maintenance and planned replacement cycles.`,
      outcome: `Reduces unplanned downtime when a component fails or wears out.`,
    },
    {
      problem: `Using a non-compatible part to keep equipment running creates secondary problems.\nThis often leads to further failure or reduced performance elsewhere.`,
      solution: `Compatible with standard equipment configurations in this category. No adaptation required.`,
      outcome: `Maintains equipment performance without introducing secondary issues.`,
    },
    {
      problem: `Components sourced from multiple suppliers create complexity in tracking and reordering.\nThe administrative overhead adds up over time.`,
      solution: `Available through a consistent supply source. Easy to add to an existing order.`,
      outcome: `Simplifies component sourcing and inventory management.`,
    },
    {
      problem: `Equipment maintenance takes longer when the right component is not readily available.\nThis extends downtime beyond what the repair itself requires.`,
      solution: `Kept in stock and available for quick dispatch. No extended lead time.`,
      outcome: `Reduces total downtime from the moment a component is needed.`,
    },
  ],

  pi_hooks: [
    `Quick note on a component from our catalog — relevant if this part fits your current equipment.`,
    `Sharing a spare or accessory from our range useful for businesses maintaining similar equipment.`,
    `One item worth knowing about if you are managing maintenance stock for this type of equipment.`,
    `Something from our catalog that covers a common component requirement in this category.`,
  ],

  pi_explains: [
    `A replacement or add-on component for standard equipment. Compatible with most configurations in this category.`,
    `Used for maintenance and repair. Straightforward to install without custom modification.`,
    `A spare part designed for regular replacement cycles. Fits standard equipment setups.`,
    `A component for functional integration into existing systems. No special tooling required.`,
  ],

  pi_benefits: [
    `Compatible with standard configurations. No modification needed.`,
    `Suitable for planned replacement cycles. Predictable availability.`,
    `Reduces sourcing time when stocked in advance.`,
  ],

  bn_hooks: [
    (_) => `Having the right component in stock before it is needed is usually less costly than sourcing it urgently.`,
    (_) => `Equipment maintenance runs more smoothly when common replacement parts are available in advance.`,
    (city) => city
      ? `Businesses in ${city} maintaining their own equipment tend to keep critical components stocked to reduce repair delays.`
      : `Businesses maintaining their own equipment tend to keep critical components stocked to reduce repair delays.`,
    (_) => `The time spent sourcing a missing component often exceeds the time it takes to install it.`,
  ],

  bn_explains: [
    `A component suited for planned stock. Available for dispatch when needed.`,
    `Works with standard equipment in this category — no custom sourcing required.`,
    `A spare part with a predictable replacement cycle. Easy to add to regular procurement.`,
  ],

  bn_benefits: [
    `Reduces repair time when the component is already in stock.`,
    `Simplifies maintenance planning when sourced proactively.`,
    `Useful when managing equipment that requires regular component replacement.`,
    `Helpful when a single component affects the operation of a larger system.`,
  ],

  sp_blocks: [
    {
      hook: `A frequently ordered component among businesses managing maintenance stock for similar equipment.`,
      note: `Often chosen for its compatibility with standard configurations and straightforward installation.`,
      benefit: `Reliable across standard equipment setups. No adaptation needed.`,
    },
    {
      hook: `One of our more consistently ordered parts among businesses maintaining this type of equipment.`,
      note: `Usually selected when businesses want a reliable spare part from a consistent supply source.`,
      benefit: `Available for quick dispatch. Reduces sourcing lead time.`,
    },
    {
      hook: `A component that is commonly added to regular orders once businesses start stocking it proactively.`,
      note: `Used in settings where having common parts available reduces equipment downtime.`,
      benefit: `Predictable availability. Simplifies maintenance planning.`,
    },
  ],

  dp_blocks: [
    {
      hook: `Sharing something from our component range — relevant if you maintain equipment in this category.`,
      detail: `A replacement or add-on component for standard equipment. In stock. Ready for dispatch.`,
      benefit: `Compatible with standard configurations. No modification needed.`,
    },
    {
      hook: `Quick note on a component from our catalog.`,
      detail: `Used for equipment maintenance and repair. Straightforward to install.`,
      benefit: `Reduces repair time when kept as a stock item.`,
    },
  ],
};

// ══════════════════════════════════════════════════════════════════════════════
// GENERAL PRODUCTS — fallback for unclassified products
// ══════════════════════════════════════════════════════════════════════════════

const GENERAL_POOLS: ProductClassPools = {

  ed_hooks: [
    (_) => `Knowing what is available from a supplier before it is needed reduces lead time when the need arises.`,
    (_) => `Using a purpose-built product for a recurring task is usually more reliable than adapting a general alternative.`,
    (city) => city
      ? `Businesses in ${city} with regular procurement needs often consolidate to a reliable supplier once they find one that fits.`
      : `Businesses with regular procurement needs often consolidate to a reliable supplier once they find one that fits.`,
    (_) => `A product sourced proactively is almost always less costly than one sourced under urgency.`,
    (_) => `Operational routines that rely on a single, consistent product tend to be easier to manage over time.`,
  ],

  ed_explains: [
    `A product from our catalog designed for a specific operational purpose. Suitable for regular use.`,
    `Used in business settings where a dedicated product simplifies a recurring operational task.`,
    `Designed for consistent performance under regular use. Standard configurations available.`,
    `A product suited for the operational requirement it is designed to address.`,
  ],

  ed_benefits: [
    `Useful when a specific product is needed rather than a general alternative.`,
    `Reduces procurement lead time when sourced in advance.`,
    `Simplifies operations where a dedicated product replaces a workaround.`,
    `Suitable for regular use with predictable performance.`,
  ],

  ps_blocks: [
    {
      problem: `Using a general-purpose product for a specific task often creates more work than a dedicated option.\nThe workaround adds time and inconsistency to the process.`,
      solution: `Designed for the specific task — not adapted from a general-purpose alternative.`,
      outcome: `Reduces time spent correcting results from an ill-suited workaround.`,
    },
    {
      problem: `Sourcing products reactively — only when the need arises — creates avoidable delays.\nLead times add up when procurement is not planned.`,
      solution: `Available through a consistent supply source. Straightforward to plan and reorder.`,
      outcome: `Reduces lead time when sourced proactively as part of regular procurement.`,
    },
    {
      problem: `Products from multiple suppliers add complexity to procurement and inventory management.\nConsolidating to fewer suppliers reduces the overhead.`,
      solution: `Available to add to an existing order — no additional supplier relationship needed.`,
      outcome: `Simplifies procurement without adding a new vendor to manage.`,
    },
    {
      problem: `A product used outside its intended application often fails earlier than expected.\nThis creates unplanned costs that compound over time.`,
      solution: `Designed for the specific application — performs as expected within intended use.`,
      outcome: `More predictable performance and cost over regular use.`,
    },
  ],

  pi_hooks: [
    `Quick note on something from our catalog — might be useful depending on what you are currently managing.`,
    `Sharing a product from our range that tends to come up with businesses handling similar requirements.`,
    `One item worth knowing about if you are looking for a reliable product in this category.`,
    `Something from our catalog that may cover a requirement you are currently managing.`,
  ],

  pi_explains: [
    `A product from our catalog for regular operational use. Works in most standard configurations.`,
    `Used in business settings where a specific product is needed for a recurring task.`,
    `Designed for consistent performance under regular use. Straightforward to integrate.`,
    `A product suited for the operational requirement it is designed to address.`,
  ],

  pi_benefits: [
    `Standard configuration. No customization required.`,
    `Designed for regular use. Minimal maintenance.`,
    `Works with most standard operational setups.`,
  ],

  bn_hooks: [
    (_) => `The right product for a specific task is usually more reliable than a general-purpose alternative over time.`,
    (_) => `Having a dedicated product for a recurring operational need reduces the effort involved each time.`,
    (city) => city
      ? `Businesses in ${city} often consolidate to a reliable product once they find one that fits their recurring requirements.`
      : `Businesses often consolidate to a reliable product once they find one that fits their recurring requirements.`,
    (_) => `A product suited to the task reduces the time spent correcting results from a less suitable alternative.`,
  ],

  bn_explains: [
    `A product designed for the specific task — performs consistently without requiring adaptation.`,
    `Suited to the operational need it addresses. No workaround required.`,
    `Designed for regular use. Consistent results across repeated applications.`,
  ],

  bn_benefits: [
    `Reduces the effort involved in each use compared to a general-purpose alternative.`,
    `Useful when a dedicated product replaces an improvised workaround.`,
    `Simplifies procurement when the need is recurring and predictable.`,
    `Suitable when consistency matters more than versatility.`,
  ],

  sp_blocks: [
    {
      hook: `A consistently ordered product among businesses managing similar operational requirements.`,
      note: `Usually chosen for its reliability and straightforward integration into existing workflows.`,
      benefit: `Works in most standard configurations. Low ongoing maintenance.`,
    },
    {
      hook: `One of our more regularly ordered items among businesses in this segment.`,
      note: `Often selected when businesses want a reliable option for a recurring operational need.`,
      benefit: `Consistent performance. Easy to add to regular procurement.`,
    },
    {
      hook: `A product that is commonly incorporated into regular procurement once businesses start using it.`,
      note: `Used where a dedicated product simplifies a task that previously needed a workaround.`,
      benefit: `Reduces recurring operational friction. Predictable performance.`,
    },
  ],

  dp_blocks: [
    {
      hook: `Sharing something from our catalog — might be relevant to what you are currently managing.`,
      detail: `A product for operational use. In stock. Standard configurations available.`,
      benefit: `Fits most standard setups. No special requirements.`,
    },
    {
      hook: `Quick note on a product from our range.`,
      detail: `Used for recurring operational needs. Easy to integrate into an existing workflow.`,
      benefit: `Consistent performance. Low maintenance.`,
    },
  ],
};

const POOL_MAP: Record<ProductClass, ProductClassPools> = {
  display:    DISPLAY_POOLS,
  machine:    MACHINE_POOLS,
  consumable: CONSUMABLE_POOLS,
  component:  COMPONENT_POOLS,
  general:    GENERAL_POOLS,
};

// ══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE LAYER
// ══════════════════════════════════════════════════════════════════════════════

interface ProductKnowledge {
  productType:     string;
  primaryUse:      string | null;
  targetUser:      string | null;
  material:        string | null;
  industryContext: string | null;
  enrich:          string | null;
  confidence:      number;  // 0–100; replaces the old boolean isRich
}

// ── Industry keyword → context label ─────────────────────────────────────────
const INDUSTRY_KEYWORDS: [string, string][] = [
  ['optical',    'optical manufacturing'],
  ['lens',       'optical lens processing'],
  ['optic',      'optical manufacturing'],
  ['dental',     'dental industry'],
  ['ortho',      'dental industry'],
  ['textile',    'textile industry'],
  ['fabric',     'textile industry'],
  ['garment',    'textile industry'],
  ['automotive', 'automotive industry'],
  ['vehicle',    'automotive industry'],
  ['tyre',       'automotive industry'],
  ['woodwork',   'woodworking'],
  ['timber',     'woodworking'],
  ['carpentry',  'woodworking'],
  ['metal',      'metal fabrication'],
  ['welding',    'metal fabrication'],
  ['pharma',     'pharmaceutical industry'],
  ['medical',    'healthcare'],
  ['surgical',   'healthcare'],
  ['glass',      'glass industry'],
  ['ceramic',    'ceramics industry'],
  ['printing',   'printing industry'],
  ['packaging',  'packaging industry'],
  ['food',       'food industry'],
];

// ── Use-case keyword → primary use phrase ─────────────────────────────────────
const USE_KEYWORDS: [string, string][] = [
  ['edging',      'edge finishing'],
  ['finishing',   'surface finishing'],
  ['grinding',    'surface grinding'],
  ['cutting',     'material cutting'],
  ['polishing',   'surface polishing'],
  ['deburring',   'deburring operations'],
  ['drilling',    'drilling operations'],
  ['milling',     'milling operations'],
  ['cleaning',    'cleaning and maintenance'],
  ['washing',     'cleaning and maintenance'],
  ['lubricating', 'lubrication'],
  ['lubrication', 'lubrication'],
  ['fastener',    'fastening and assembly'],
  ['fastening',   'fastening and assembly'],
  ['mounting',    'equipment mounting'],
  ['assembly',    'assembly operations'],
  ['display',     'product display organization'],
  ['organizing',  'product organization'],
  ['sorting',     'product sorting and organization'],
];

// ── Material keywords (whole-word) ────────────────────────────────────────────
const MATERIAL_KEYWORDS: string[] = [
  'diamond', 'carbide', 'abrasive', 'wire', 'stainless',
  'aluminum', 'rubber', 'ceramic', 'silicon', 'brass',
  'chrome', 'steel', 'iron', 'plastic', 'glass',
];

// ── Industry → who uses it ────────────────────────────────────────────────────
const TARGET_USER_MAP: Record<string, string> = {
  'optical manufacturing':    'optical labs',
  'optical lens processing':  'optical lens labs',
  'dental industry':          'dental practices and labs',
  'textile industry':         'textile manufacturers',
  'metal fabrication':        'metal fabrication units',
  'woodworking':              'woodworking shops',
  'glass industry':           'glass processing units',
  'automotive industry':      'automotive workshops',
  'surface finishing':        'manufacturing and finishing units',
  'cleaning and maintenance': 'facilities and maintenance teams',
  'pharmaceutical industry':  'pharmaceutical manufacturers',
  'healthcare':               'healthcare facilities',
  'packaging industry':       'packaging operations',
  'food industry':            'food processing units',
};

// ── HSN prefix → industry (last-resort only, must not override text signals) ──
const HSN_INDUSTRY_MAP: Record<string, string> = {
  '9001': 'optical manufacturing',
  '9002': 'optical manufacturing',
  '9003': 'optical manufacturing',
  '9004': 'optical manufacturing',
  '6804': 'surface finishing',
  '6805': 'surface finishing',
  '8460': 'metal fabrication',
  '8461': 'metal fabrication',
  '8467': 'woodworking',
  '3402': 'cleaning and maintenance',
  '3403': 'cleaning and maintenance',
  '3405': 'cleaning and maintenance',
  '7326': 'metal fabrication',
  '3920': 'packaging industry',
  '4015': 'healthcare',
};

// ── Product type nouns ────────────────────────────────────────────────────────
const PRODUCT_TYPE_NOUNS: string[] = [
  'wheel', 'blade', 'tool', 'machine', 'motor', 'drill', 'press', 'pump',
  'grinder', 'cutter', 'lathe', 'conveyor', 'device',
  'panel', 'holder', 'rack', 'stand', 'shelf', 'fixture', 'mount', 'grid',
  'hook', 'counter',
  'solution', 'liquid', 'cleaner', 'pad', 'spray', 'gel', 'lubricant',
  'powder', 'solvent',
  'bracket', 'connector', 'fitting', 'pin', 'bolt', 'screw', 'clip',
  'component', 'part', 'accessory', 'kit', 'set',
];

// ── Text layer ordering: [text, sourceName, confidenceBonus] ─────────────────
// Priority: description → tags → productType → name → handle → vendor
// HSN is handled separately as a last-resort fallback.
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

// ── Pure helper functions ─────────────────────────────────────────────────────

function deriveProductType(words: string[]): string {
  for (const noun of PRODUCT_TYPE_NOUNS) {
    if (words.includes(noun)) return noun;
  }
  const stop = new Set(['for', 'and', 'the', 'of', 'in', 'a', 'an', 'with', 'to', 'by', 'on']);
  const candidates = words.filter(w => !stop.has(w) && w.length > 2 && !/^\d/.test(w));
  return candidates[candidates.length - 1] ?? 'product';
}

function buildEnrichSentence(
  productType: string,
  primaryUse: string | null,
  material: string | null,
  industryContext: string | null,
  targetUser: string | null,
): string | null {
  const typeWord = productType !== 'product' ? productType : null;

  if (material && typeWord && primaryUse && industryContext) {
    return `A ${material} ${typeWord} used for ${primaryUse} in ${industryContext}.`;
  }
  if (typeWord && primaryUse && targetUser) {
    return `A ${typeWord} used by ${targetUser} for ${primaryUse}.`;
  }
  if (material && typeWord && primaryUse) {
    return `A ${material} ${typeWord} designed for ${primaryUse}.`;
  }
  if (primaryUse && industryContext) {
    return `Commonly used in ${industryContext} for ${primaryUse}.`;
  }
  if (primaryUse && targetUser) {
    return `Used by ${targetUser} for ${primaryUse}.`;
  }
  if (typeWord && primaryUse) {
    return `Designed for ${primaryUse} applications.`;
  }
  if (industryContext && targetUser) {
    return `Used by ${targetUser} in ${industryContext}.`;
  }
  if (industryContext) {
    return `Commonly used in ${industryContext}.`;
  }
  return null;
}

function deriveKnowledgeBenefit(knowledge: ProductKnowledge): string | null {
  const { primaryUse, targetUser, industryContext } = knowledge;
  if (primaryUse && targetUser) {
    return `Useful for ${targetUser} where ${primaryUse} is a routine requirement.`;
  }
  if (primaryUse && industryContext) {
    return `Suitable for ${industryContext} where ${primaryUse} is a regular operational need.`;
  }
  if (primaryUse) {
    return `Useful when ${primaryUse} is a regular operational requirement.`;
  }
  if (targetUser) {
    return `Often used by ${targetUser} as a dedicated product for this task.`;
  }
  return null;
}

function extractProductKnowledge(
  product: ShopifyCatalogItem,
  productClass: ProductClass,
): ProductKnowledge {
  const layers = buildTextLayers(product);

  // All tokens combined — used for material and product-type extraction
  const allText = layers.map(([t]) => t).concat(product.sku?.toLowerCase() ?? '').join(' ');
  const words   = allText.replace(/[-_/]/g, ' ').split(/\s+/).filter(Boolean);

  // ── Extract industryContext — first matching layer wins ──────────────────────
  let industryContext: string | null = null;
  let hsnFallbackUsed = false;

  for (const [layerText] of layers) {
    if (!layerText) continue;
    for (const [kw, ind] of INDUSTRY_KEYWORDS) {
      if (layerText.includes(kw)) { industryContext = ind; break; }
    }
    if (industryContext) break;
  }

  // HSN only as last resort — and NEVER for display products (prevents cross-class pollution)
  if (!industryContext && product.hsnCode && productClass !== 'display') {
    const prefix = product.hsnCode.substring(0, 4);
    const mapped = HSN_INDUSTRY_MAP[prefix];
    if (mapped) { industryContext = mapped; hsnFallbackUsed = true; }
  }

  // ── Extract primaryUse — same priority order ─────────────────────────────────
  let primaryUse: string | null = null;
  for (const [layerText] of layers) {
    if (!layerText) continue;
    for (const [kw, use] of USE_KEYWORDS) {
      if (layerText.includes(kw)) { primaryUse = use; break; }
    }
    if (primaryUse) break;
  }

  // ── Extract material ──────────────────────────────────────────────────────────
  let material: string | null = null;
  for (const kw of MATERIAL_KEYWORDS) {
    if (words.includes(kw)) { material = kw; break; }
  }

  const productType = deriveProductType(words);
  const targetUser  = industryContext ? (TARGET_USER_MAP[industryContext] ?? null) : null;
  const enrich      = buildEnrichSentence(productType, primaryUse, material, industryContext, targetUser);

  // ── Confidence scoring — each source that contributed ANY signal adds its bonus ─
  // Scoring is independent of extraction priority so all useful sources are counted.
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

// ══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ══════════════════════════════════════════════════════════════════════════════

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

    const productName  = product.itemName ?? product.sku ?? 'this product';
    const city         = customer.city ?? '';
    const name         = customer.name?.trim() || 'there';
    const sku          = product.sku ?? '';
    const productClass = classifyProduct(product);
    const pools        = POOL_MAP[productClass];
    const knowledge    = extractProductKnowledge(product, productClass);

    const category   = this._pickCategory();
    const greeting   = this._pickRandom(GREETINGS)(name);
    const softCta    = this._pickSoftCta(customer.phone);
    const callLabel  = this._pickRandom(CALL_LABELS);
    const productUrl = this._buildProductUrl(product);

    const { hook, explain, benefit } = this._categoryContent(category, city, pools, knowledge);

    const offerLine = offer?.text
      ? (offer.title ? `${offer.title}: ${offer.text}` : offer.text)
      : undefined;

    const message = this._buildMessage({
      greeting, productName, sku, hook, explain, benefit,
      softCta, callLabel, telecallerPhone: telecaller_phone, productUrl, offerLine,
    });

    this._assertSafe(message);

    this.logger.log(
      `[PROMO_AI] category=${category} class=${productClass} ` +
      `industry=${knowledge.industryContext ?? 'none'} confidence=${knowledge.confidence} ` +
      `sku=${sku} offer=${!!offerLine} customer=${customer.phone} length=${message.length}`,
    );

    return {
      message,
      imageUrl:   product.image || null,
      productUrl,
      metadata: {
        templateVariant:     `v${Math.floor(Math.random() * 3) + 1}`,
        contentCategory:     category,
        softCtaUsed:         softCta,
        hookType:            category,
        messageLength:       message.length,
        productSku:          sku,
        productClass,
        industryContext:     knowledge.industryContext ?? null,
        knowledgeConfidence: knowledge.confidence,
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

  // ── Content generation — two-stage: pool pull → knowledge override ────────────

  private _categoryContent(
    category: ContentCategory,
    city: string,
    p: ProductClassPools,
    knowledge: ProductKnowledge,
  ): { hook: string; explain: string; benefit: string } {
    const { hook, poolExplain, poolBenefit } = this._pullFromPool(category, city, p);
    const explain = this._resolveExplain(category, poolExplain, knowledge);
    // Benefit override only at high confidence — weak knowledge must not create weak benefits.
    const benefit = knowledge.confidence >= 70
      ? (deriveKnowledgeBenefit(knowledge) ?? poolBenefit)
      : poolBenefit;
    return { hook, explain, benefit };
  }

  private _pullFromPool(
    category: ContentCategory,
    city: string,
    p: ProductClassPools,
  ): { hook: string; poolExplain: string; poolBenefit: string } {
    switch (category) {
      case 'educational':
        return {
          hook:        this._pickRandom(p.ed_hooks)(city),
          poolExplain: this._pickRandom(p.ed_explains),
          poolBenefit: this._pickRandom(p.ed_benefits),
        };
      case 'product_info':
        return {
          hook:        this._pickRandom(p.pi_hooks),
          poolExplain: this._pickRandom(p.pi_explains),
          poolBenefit: this._pickRandom(p.pi_benefits),
        };
      case 'benefit':
        return {
          hook:        this._pickRandom(p.bn_hooks)(city),
          poolExplain: this._pickRandom(p.bn_explains),
          poolBenefit: this._pickRandom(p.bn_benefits),
        };
      case 'problem_sol': {
        const b = this._pickRandom(p.ps_blocks);
        return { hook: b.problem, poolExplain: b.solution, poolBenefit: b.outcome };
      }
      case 'social_proof': {
        const b = this._pickRandom(p.sp_blocks);
        return { hook: b.hook, poolExplain: b.note, poolBenefit: b.benefit };
      }
      case 'direct_promo': {
        const b = this._pickRandom(p.dp_blocks);
        return { hook: b.hook, poolExplain: b.detail, poolBenefit: b.benefit };
      }
    }
  }

  // Confidence thresholds for explain override:
  //   < 40  → pool explain always wins (knowledge too weak to trust)
  //   40–70 → knowledge explain replaces pool explain; pool benefit retained
  //   > 70  → knowledge explain; knowledge benefit (handled in _categoryContent)
  private _resolveExplain(
    category: ContentCategory,
    poolExplain: string,
    knowledge: ProductKnowledge,
  ): string {
    const { enrich, confidence } = knowledge;
    if (!enrich || confidence < 40) return poolExplain;
    // problem_sol: prepend product context before the solution (which addresses the stated problem)
    if (category === 'problem_sol') return `${enrich}\n${poolExplain}`;
    return enrich;
  }

  // ── Message assembly ──────────────────────────────────────────────────────────

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
      greeting, ``,
      hook,     ``,
      `*${productName}*`, `SKU: ${sku}`, ``,
      explain,  ``,
      benefit,
    ];

    if (offerLine) lines.push(``, offerLine);

    lines.push(``, softCta, ``,
      `📞 ${callLabel}: ${telecallerPhone}`,
      `🛍 View Product: ${productUrl}`,
    );

    return lines.join('\n');
  }

  // ── Product URL ───────────────────────────────────────────────────────────────

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

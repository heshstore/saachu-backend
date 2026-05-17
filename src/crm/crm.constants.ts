/**
 * CRM-wide shared constants.
 * Single source of truth for role lists, quality filters, and operational thresholds.
 * Import from here — do NOT inline these arrays or strings in service/controller methods.
 */

// ── Role sets ─────────────────────────────────────────────────────────────────

/**
 * Roles with full data visibility: can see all org leads, all analytics,
 * includeInactive flag, and manager-level features.
 */
export const CRM_FULL_ACCESS_ROLES = ['Admin', 'COO', 'Sales Manager'] as const;

/**
 * Roles that can bypass WORKFLOW regression protection.
 * Intentionally narrower than CRM_FULL_ACCESS_ROLES — Sales Manager can see all data
 * but cannot override workflow state regression guards for telecallers.
 * Do NOT add 'Sales Manager' here without a deliberate product decision.
 */
export const CRM_WORKFLOW_BYPASS_ROLES = ['Admin', 'COO'] as const;

/** Type helpers */
export type CrmFullAccessRole  = typeof CRM_FULL_ACCESS_ROLES[number];
export type CrmWorkflowBypass  = typeof CRM_WORKFLOW_BYPASS_ROLES[number];

// ── Lead quality ──────────────────────────────────────────────────────────────

/**
 * Quality tiers excluded from all operational views (queue, available leads, analytics).
 * NULL quality rows (pre-backfill) are treated as operational — included, not excluded.
 *
 * TRACKING_ONLY: no identity, analytics-only
 * JUNK:          no identity, no product interest
 * DUPLICATE:     legacy duplicate marker (new leads never receive this quality since
 *                requirement-aware dedup prevents true phone+requirement duplicates)
 */
export const CRM_NON_OPERATIONAL_QUALITIES = ['TRACKING_ONLY', 'JUNK', 'DUPLICATE'] as const;

/**
 * SQL WHERE fragment for filtering non-operational quality tiers.
 * Used in raw SQL queries (analytics, reporting).
 * Assumes the lead_quality column is unaliased — alias with replace() when needed.
 *
 * Usage:  `WHERE ${CRM_OPERATIONAL_QUALITY_SQL}`
 *   or:   `AND ${CRM_OPERATIONAL_QUALITY_SQL.replace(/lead_quality/g, 'l.lead_quality')}`
 */
export const CRM_OPERATIONAL_QUALITY_SQL =
  `(lead_quality IS NULL OR lead_quality NOT IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE'))`;

// ── Operational identity predicate ────────────────────────────────────────────

/**
 * True when a lead has both (a) reachable contact info and (b) operational quality tier.
 *
 * Use everywhere identity matters:
 *   queue eligibility, workflow transitions, followup creation, assignment,
 *   automation, escalation, operational filters.
 *
 * Intentionally duck-typed (no Lead import) to avoid circular dependencies.
 */
export function hasOperationalIdentity(
  lead: { phone?: string | null; email?: string | null; lead_quality?: string | null },
): boolean {
  const phone = lead.phone?.trim();
  const hasContact =
    !!(phone && phone.toLowerCase() !== 'unknown') || !!(lead.email?.trim());
  const q = lead.lead_quality;
  const isOperational =
    !q || !(CRM_NON_OPERATIONAL_QUALITIES as readonly string[]).includes(q);
  return hasContact && isOperational;
}

/**
 * True when a lead has at least one callable/reachable identity field (phone or email).
 * Does NOT check lead_quality — use hasOperationalIdentity() for the full gate.
 */
export function hasContactInfo(
  lead: { phone?: string | null; email?: string | null },
): boolean {
  const phone = lead.phone?.trim();
  return !!(phone && phone.toLowerCase() !== 'unknown') || !!(lead.email?.trim());
}

/**
 * Single source of truth for WhatsApp warmup, queue planning, and release limits.
 *
 * Queue planning uses MATURE_DAILY_CAPACITY (150/day per telecaller).
 * Sender release uses RELEASE_ALLOWANCE_BY_LEVEL (warmup stage budget).
 * Health thresholds govern promotion eligibility only — never sending permission.
 */

/** Ultimate per-number daily capacity once fully warmed (L4). */
export const MATURE_DAILY_CAPACITY = 150;

/** Release budget per warmup stage — sender enforces this, not queue build. */
export const RELEASE_ALLOWANCE_BY_LEVEL = {
  1: 20,
  2: 50,
  3: 100,
  4: 150,
} as const;

export type WarmupLevel = keyof typeof RELEASE_ALLOWANCE_BY_LEVEL;

/** @deprecated Use RELEASE_ALLOWANCE_BY_LEVEL — kept for import compatibility */
export const WARMUP_LIMITS = RELEASE_ALLOWANCE_BY_LEVEL;

/** 7-day rolling window for health evaluation. */
export const HEALTH_WINDOW_DAYS = 7;

/** Minimum sends in the health window before rates are evaluated. */
export const HEALTH_MIN_SENDS_WINDOW = 20;

/** 7-day aggregate health thresholds (promotion eligibility).
 *  Only delivery/failure metrics — read and reply rates are customer behaviour,
 *  not WhatsApp number health signals. Cold promos may take 3-5 days for a read. */
export const HEALTH_THRESHOLDS = {
  minDeliveryRatePct: 60,
  maxFailRatePct: 20,
  maxBlockRatePct: 5,
} as const;

/** Per-day health for consecutive-day streak counting (IST days). */
export const PROMOTION_RULES = {
  healthyDaysRequired: 3,
  minSendsPerHealthyDay: 5,
  dailyDeliveryRateMinPct: 50,
  dailyFailRateMaxPct: 25,
} as const;

/** Warning thresholds (7-day window) — audit only, never pause.
 *  Read/reply thresholds removed: cold-promo customers take 3-5 days to engage. */
export const WARNING_THRESHOLDS = {
  minSends: 20,
  lowDeliveryRatePct: 50,
  highFailRatePct: 25,
} as const;

export function getReleaseAllowance(warmupLevel: number): number {
  return (
    (RELEASE_ALLOWANCE_BY_LEVEL as Record<number, number>)[warmupLevel] ??
    RELEASE_ALLOWANCE_BY_LEVEL[1]
  );
}

export function getMatureDailyCapacity(): number {
  return MATURE_DAILY_CAPACITY;
}

/** Sender and dashboard: daily release budget for a warmup stage. */
export function getActiveLimits(warmupLevel: number): { daily: number } {
  return { daily: getReleaseAllowance(warmupLevel) };
}

export function getWarmupLabel(level: number): string {
  const labels: Record<number, string> = {
    1: 'L1 Cool',
    2: 'L2 Warm',
    3: 'L3 Hot',
    4: 'L4 Mature',
  };
  return labels[level] ?? labels[1];
}

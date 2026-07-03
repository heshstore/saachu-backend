import {
  HEALTH_MIN_SENDS_WINDOW,
  HEALTH_THRESHOLDS,
  PROMOTION_RULES,
  WARNING_THRESHOLDS,
} from './number-limits';

export interface MessageStatusCounts {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  total: number;
}

export interface HealthMetrics extends MessageStatusCounts {
  deliveryRatePct: number;
  readRatePct: number;
  replyRatePct: number;
  failRatePct: number;
  blockRatePct: number;
  healthScore: number;
  isHealthy: boolean;
}

export interface DailyHealthRow {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  isHealthyDay: boolean;
}

export function countsFromStatusMap(
  counts: Record<string, number>,
): MessageStatusCounts {
  const sent = counts['sent'] ?? 0;
  const delivered = counts['delivered'] ?? 0;
  const read = counts['read'] ?? 0;
  const replied = counts['replied'] ?? 0;
  const failed = counts['failed'] ?? 0;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { sent, delivered, read, replied, failed, total };
}

export function computeHealthMetrics(
  counts: MessageStatusCounts,
): HealthMetrics {
  const attemptTotal = counts.sent + counts.delivered + counts.failed;
  const deliveryRatePct =
    attemptTotal > 0
      ? ((counts.delivered + counts.read + counts.replied) / attemptTotal) * 100
      : 100;
  const readBase = counts.delivered + counts.read + counts.replied;
  const readRatePct =
    readBase > 0 ? ((counts.read + counts.replied) / readBase) * 100 : 0;
  const replyRatePct =
    counts.total > 0 ? (counts.replied / counts.total) * 100 : 0;
  const failRatePct =
    counts.total > 0 ? (counts.failed / counts.total) * 100 : 0;
  const blockRatePct = failRatePct;

  // Promotion depends only on delivery health and failure rate — NOT on customer
  // read/reply engagement, which can lag 3–5 days for cold promotions.
  const isHealthy =
    counts.total >= HEALTH_MIN_SENDS_WINDOW &&
    deliveryRatePct >= HEALTH_THRESHOLDS.minDeliveryRatePct &&
    failRatePct <= HEALTH_THRESHOLDS.maxFailRatePct &&
    blockRatePct <= HEALTH_THRESHOLDS.maxBlockRatePct;

  const healthScore = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        deliveryRatePct * 0.35 +
          readRatePct * 0.25 +
          replyRatePct * 10 +
          (100 - failRatePct) * 0.25 +
          (counts.total >= HEALTH_MIN_SENDS_WINDOW ? 10 : 0),
      ),
    ),
  );

  return {
    ...counts,
    deliveryRatePct: Math.round(deliveryRatePct),
    readRatePct: Math.round(readRatePct),
    replyRatePct: Math.round(replyRatePct * 10) / 10,
    failRatePct: Math.round(failRatePct),
    blockRatePct: Math.round(blockRatePct),
    healthScore,
    isHealthy,
  };
}

export function isHealthyDay(
  row: Omit<DailyHealthRow, 'isHealthyDay'>,
): boolean {
  const attemptTotal = row.sent + row.delivered + row.failed;
  if (attemptTotal < PROMOTION_RULES.minSendsPerHealthyDay) return false;
  const deliveryRate =
    ((row.delivered + row.read + row.replied) / attemptTotal) * 100;
  const failRate = attemptTotal > 0 ? (row.failed / attemptTotal) * 100 : 0;
  return (
    deliveryRate >= PROMOTION_RULES.dailyDeliveryRateMinPct &&
    failRate <= PROMOTION_RULES.dailyFailRateMaxPct
  );
}

/** Count trailing consecutive healthy IST days (most recent first). */
export function countHealthyDayStreak(dailyRows: DailyHealthRow[]): number {
  let streak = 0;
  for (const row of dailyRows) {
    if (!row.isHealthyDay) break;
    streak++;
  }
  return streak;
}

// Read/reply warnings removed — cold-promo customers take 3-5 days to engage.
// Operator warnings fire only for genuine WhatsApp restriction signals.
export type WarningKind = 'LOW_DELIVERY_WARNING';

export function detectWarnings(metrics: HealthMetrics): WarningKind[] {
  if (metrics.total < WARNING_THRESHOLDS.minSends) return [];

  const warnings: WarningKind[] = [];
  if (metrics.deliveryRatePct < WARNING_THRESHOLDS.lowDeliveryRatePct) {
    warnings.push('LOW_DELIVERY_WARNING');
  }
  if (metrics.failRatePct > WARNING_THRESHOLDS.highFailRatePct) {
    warnings.push('LOW_DELIVERY_WARNING');
  }
  return [...new Set(warnings)];
}

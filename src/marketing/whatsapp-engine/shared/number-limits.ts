/**
 * Single source of truth for WhatsApp number send limits.
 *
 * All services that enforce, display, or monitor send limits MUST import
 * from here. Do not inline these tables elsewhere.
 *
 * Warmup level is the sole capacity control per telecaller number.
 * No additional audience caps or pilot overlays are applied.
 */

export const WARMUP_LIMITS = {
  1: { daily: 20,  hourly: 4  },
  2: { daily: 50,  hourly: 10 },
  3: { daily: 100, hourly: 18 },
  4: { daily: 150, hourly: 25 },
} as const;

export type WarmupLevel = keyof typeof WARMUP_LIMITS;

export function getActiveLimits(warmupLevel: number): { daily: number; hourly: number } {
  return (WARMUP_LIMITS as Record<number, { daily: number; hourly: number }>)[warmupLevel] ?? WARMUP_LIMITS[1];
}

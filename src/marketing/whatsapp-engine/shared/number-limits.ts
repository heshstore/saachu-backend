/**
 * Single source of truth for WhatsApp number warmup caps.
 *
 * All services that enforce, display, or monitor send limits MUST import
 * from here. Do not inline these tables elsewhere.
 */

export const WARMUP_LIMITS = {
  1: { daily: 20,  hourly: 4  },
  2: { daily: 50,  hourly: 10 },
  3: { daily: 100, hourly: 18 },
  4: { daily: 150, hourly: 25 },
} as const;

export const PILOT_LIMITS = {
  1: { daily: 10, hourly: 2 },
  2: { daily: 20, hourly: 5 },
  3: { daily: 30, hourly: 7 },
  4: { daily: 50, hourly: 10 },
} as const;

export type WarmupLevel = keyof typeof WARMUP_LIMITS;

export function getActiveLimits(warmupLevel: number): { daily: number; hourly: number } {
  const isPilot = process.env.WHATSAPP_ENGINE_PILOT_MODE === 'true';
  const table   = isPilot ? PILOT_LIMITS : WARMUP_LIMITS;
  return (table as Record<number, { daily: number; hourly: number }>)[warmupLevel] ?? table[1];
}

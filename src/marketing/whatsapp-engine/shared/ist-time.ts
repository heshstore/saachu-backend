const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getIstDayBounds(now = new Date()): { start: Date; end: Date } {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d) - IST_OFFSET_MS;
  return {
    start: new Date(startUtcMs),
    end: new Date(startUtcMs + DAY_MS),
  };
}

export function getIstDateKey(now = new Date()): string {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m = String(istNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istNow.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

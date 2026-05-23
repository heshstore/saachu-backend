/**
 * Single source of truth for transient Neon/PostgreSQL connectivity error detection.
 * Import this wherever you need to decide between "skip and retry later" vs "log and throw".
 */

const TRANSIENT_PATTERNS = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'connection terminated',
  'Connection terminated',
  'connection refused',
  'getaddrinfo',
  'read ECONNRESET',
  'write ECONNRESET',
  'pool timeout',
  'Connection pool timeout',
  'Client was closed',
  'acquire timeout',
  'ConnectionRefusedError',
];

export function isTransientDbError(err: any): boolean {
  const text = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.name ?? ''}`;
  return TRANSIENT_PATTERNS.some((p) => text.includes(p));
}

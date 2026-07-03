export enum SkipReason {
  NOT_ON_WHATSAPP = 'NOT_ON_WHATSAPP',
  DUPLICATE_PHONE = 'DUPLICATE_PHONE',
  CUSTOMER_PROTECTED = 'CUSTOMER_PROTECTED',
  INVALID_NUMBER = 'INVALID_NUMBER',
  COOLDOWN_ACTIVE = 'COOLDOWN_ACTIVE',
  BLACKLISTED = 'BLACKLISTED',
  MISSING_REQUIRED_DATA = 'MISSING_REQUIRED_DATA',
  NO_ACTIVE_NUMBER = 'NO_ACTIVE_NUMBER',
  NUMBER_DISCONNECTED = 'NUMBER_DISCONNECTED',
  OUTSIDE_SEND_WINDOW = 'OUTSIDE_SEND_WINDOW',
  ASSIGNED_SENDER_UNAVAILABLE = 'ASSIGNED_SENDER_UNAVAILABLE',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

const EXACT = new Set<string>(Object.values(SkipReason));

export function normalizeSkipReason(
  raw: string | null | undefined,
): SkipReason {
  const reason = String(raw ?? '').trim();
  const upper = reason.toUpperCase();
  if (EXACT.has(upper)) return upper as SkipReason;

  if (
    upper.includes('INVALID_WA_NUMBER') ||
    upper.includes('NOT REGISTERED ON WHATSAPP')
  ) {
    return SkipReason.NOT_ON_WHATSAPP;
  }
  if (upper.includes('DUPLICATE')) return SkipReason.DUPLICATE_PHONE;
  if (
    upper.includes('OPT_OUT') ||
    upper.includes('PROTECTED') ||
    upper.includes('TEST_MODE')
  ) {
    return SkipReason.CUSTOMER_PROTECTED;
  }
  if (
    upper.includes('ASSIGNED_SENDER') ||
    upper.includes('SENDER_UNAVAILABLE')
  ) {
    return SkipReason.ASSIGNED_SENDER_UNAVAILABLE;
  }
  if (
    upper.includes('NO_ACTIVE_NUMBER') ||
    upper.includes('NO ACTIVE NUMBER')
  ) {
    return SkipReason.NO_ACTIVE_NUMBER;
  }
  if (upper.includes('NUMBER_DISCONNECTED') || upper.includes('DISCONNECTED')) {
    return SkipReason.NUMBER_DISCONNECTED;
  }
  if (
    upper.includes('OUTSIDE_SEND_WINDOW') ||
    upper.includes('SEND_WINDOW') ||
    upper.includes('OUTSIDE WINDOW')
  ) {
    return SkipReason.OUTSIDE_SEND_WINDOW;
  }
  if (upper.includes('INVALID') || upper.includes('BAD_PHONE'))
    return SkipReason.INVALID_NUMBER;
  if (
    upper.includes('COOLDOWN') ||
    upper.includes('FINGERPRINT') ||
    upper.includes('SAME TEMPLATE')
  ) {
    return SkipReason.COOLDOWN_ACTIVE;
  }
  if (upper.includes('BLACKLIST')) return SkipReason.BLACKLISTED;
  if (
    upper.includes('NO USABLE') ||
    upper.includes('NO_BODY') ||
    upper.includes('MISSING')
  ) {
    return SkipReason.MISSING_REQUIRED_DATA;
  }
  return SkipReason.UNKNOWN_ERROR;
}

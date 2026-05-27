/**
 * Centralized operational alert recipient phone numbers (country code + number, no +).
 *
 * Use this for all system-level CRM WhatsApp alerts:
 *   - critical failures
 *   - queue failures
 *   - sync failures
 *   - WhatsApp disconnect alerts
 *   - operational reminders and escalations
 *
 * To add or remove recipients, edit this array only — never hardcode phones elsewhere.
 */
export const OPERATIONAL_ALERT_PHONES: readonly string[] = [
  '919884052555',
  '917010366206',
] as const;

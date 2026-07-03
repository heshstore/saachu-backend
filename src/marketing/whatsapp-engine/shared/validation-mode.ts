/**
 * Validation Mode: contacts with is_test_contact = true bypass customer-side restrictions
 * (cooldown, quality score, queue dedup, content fingerprint) so internal test numbers
 * remain sendable for every validation run.
 *
 * NOT bypassed: opt_out, is_whatsapp_valid, daily caps, send windows,
 * telecaller ownership, product rotation, connected-number checks.
 */
export function isValidationContact(contact: {
  is_test_contact?: boolean | null;
}): boolean {
  return contact.is_test_contact === true;
}

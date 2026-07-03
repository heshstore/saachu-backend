/**
 * Promotional Contacts geo quality — independent from quality_score / contact_strength.
 */

export type GeoQuality = 'VALID' | 'PARTIAL' | 'JUNK';

export type GeoCorrection = {
  field: 'state' | 'country' | 'city';
  imported: string;
  resolved: string;
  source: string;
  action: 'TRUST_VERIFIED';
};

const BLANK = new Set(['', 'null', 'undefined', 'n/a', 'na', '-', '—']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const GARBAGE_CITY_RE = /^[\d\s#@!$%^&*()+=\[\]{}|\\;:'",.<>?/`~]+$/;

export function isMeaningfulGeo(value: string | null | undefined): boolean {
  if (value == null) return false;
  const t = value.trim();
  return t.length > 0 && !BLANK.has(t.toLowerCase());
}

export function isValidEmailFormat(raw: string | null | undefined): boolean {
  if (!isMeaningfulGeo(raw)) return false;
  return EMAIL_RE.test(raw.trim());
}

/** Obvious garbage — not merely unresolved. */
export function isGarbageCity(city: string | null | undefined): boolean {
  if (!isMeaningfulGeo(city)) return false;
  const t = city.trim();
  if (t.length < 2) return true;
  if (GARBAGE_CITY_RE.test(t)) return true;
  if (/^(.)\1{4,}$/i.test(t.replace(/\s/g, ''))) return true;
  return false;
}

export type GeoQualityInput = {
  phone: string | null;
  email: string | null;
  name: string | null;
  customer_name?: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phoneValid: boolean;
  emailValid: boolean;
  cityResolved: boolean;
};

/**
 * VALID   — phone valid + city resolved + state + country derived
 * PARTIAL — valuable lead without full geo (phone-only, phone+name, unresolved city)
 * JUNK    — no usable identity or garbage city
 */
export function classifyGeoQuality(input: GeoQualityInput): GeoQuality {
  const hasName =
    isMeaningfulGeo(input.name) || isMeaningfulGeo(input.customer_name);
  const hasCity = isMeaningfulGeo(input.city);

  if (hasCity && isGarbageCity(input.city)) return 'JUNK';
  if (!input.phoneValid && !input.emailValid) return 'JUNK';
  if (input.emailValid && !input.phoneValid && !hasName && !hasCity)
    return 'JUNK';

  const fullyResolved =
    input.phoneValid &&
    input.cityResolved &&
    isMeaningfulGeo(input.state) &&
    isMeaningfulGeo(input.country);

  if (fullyResolved) return 'VALID';

  // Phone-only, phone+name, email-only, unresolved city — all kept as PARTIAL.
  if (input.phoneValid || input.emailValid) return 'PARTIAL';

  return 'JUNK';
}

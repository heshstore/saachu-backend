import { MarketingAudience } from '../entities/marketing-audience.entity';
import type { GeoCorrection, GeoQuality } from './geo-quality.util';
import type { GeoSource } from './geo-resolver.service';

export type ContactStrength = 'LOW' | 'MEDIUM' | 'HIGH';

export type ImportRow = Partial<MarketingAudience> & {
  source?: string | null;
  /** Set by geo pipeline before merge — verified state/country from city resolver. */
  _geoResolved?: boolean;
  _geoSource?: GeoSource;
  _geoCorrections?: GeoCorrection[];
  _geoQuality?: GeoQuality;
  /** 1-based index in the original input rows array — used for skip diagnostics. */
  _rowIndex?: number;
};

const BLANK = new Set(['', 'null', 'undefined', 'n/a', 'na', '-', '—']);

export function isMeaningful(value: string | null | undefined): boolean {
  if (value == null) return false;
  const t = value.trim();
  return t.length > 0 && !BLANK.has(t.toLowerCase());
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!isMeaningful(raw)) return null;
  return raw!.trim().toLowerCase();
}

/** Prefer the longer meaningful display name. */
export function mergeName(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const e = isMeaningful(existing) ? existing!.trim() : null;
  const i = isMeaningful(incoming) ? incoming!.trim() : null;
  if (!i) return e;
  if (!e) return i;
  return i.length > e.length ? i : e;
}

/** Fill only when existing is empty; never replace with blank. */
export function mergeFillMissing(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (isMeaningful(existing)) return existing!.trim();
  return isMeaningful(incoming) ? incoming!.trim() : (existing ?? null);
}

/** Email: fill only if existing empty. */
export function mergeEmail(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (isMeaningful(existing)) return existing!.trim();
  return isMeaningful(incoming) ? incoming!.trim().toLowerCase() : (existing ?? null);
}

/** Append incoming notes; never destroy existing. */
export function mergeNotes(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const e = isMeaningful(existing) ? existing!.trim() : '';
  const i = isMeaningful(incoming) ? incoming!.trim() : '';
  if (!i) return e || null;
  if (!e) return i;
  if (e.includes(i)) return e;
  return `${e}\n---\n${i}`;
}

/** Union source labels; preserve history. */
export function mergeSources(
  existing: string[] | null | undefined,
  incomingSource: string | null | undefined,
): string[] {
  const base = Array.isArray(existing) ? [...existing] : [];
  const label = isMeaningful(incomingSource) ? incomingSource!.trim() : null;
  if (!label) return base;
  if (!base.some(s => s.toLowerCase() === label.toLowerCase())) {
    base.push(label);
  }
  return base;
}

export function computeContactStrength(row: {
  phone?: string | null;
  name?: string | null;
  customer_name?: string | null;
  email?: string | null;
  city?: string | null;
  business_type?: string | null;
}): ContactStrength {
  const hasPhone = isMeaningful(row.phone);
  const hasName = isMeaningful(row.name) || isMeaningful(row.customer_name);
  const hasCity = isMeaningful(row.city);
  const hasEmail = isMeaningful(row.email);
  const hasBiz = isMeaningful(row.business_type);

  if (hasPhone && hasName && hasEmail && hasCity && hasBiz) return 'HIGH';
  if (hasPhone && hasName && hasCity) return 'MEDIUM';
  return 'LOW';
}

/** Merge two import rows (same phone) — incoming enriches accumulator. */
export function mergeImportRows(
  acc: ImportRow,
  incoming: ImportRow,
): ImportRow {
  const sourceLabel = incoming.source ?? acc.source ?? 'CSV Import';
  const sources = mergeSources(acc.sources_used as string[] | undefined, sourceLabel);

  return {
    ...acc,
    phone: acc.phone ?? incoming.phone,
    name: mergeName(acc.name, incoming.name) ?? mergeName(acc.customer_name, incoming.customer_name),
    customer_name: mergeName(acc.customer_name, incoming.customer_name) ?? mergeName(acc.name, incoming.name),
    email: mergeEmail(acc.email, incoming.email),
    ...mergeGeoFields(acc, incoming),
    company: mergeFillMissing(acc.company, incoming.company),
    gst: mergeFillMissing(acc.gst, incoming.gst),
    business_type: mergeFillMissing(acc.business_type, incoming.business_type),
    address: mergeFillMissing(acc.address, incoming.address),
    mobile_2: mergeFillMissing(acc.mobile_2, incoming.mobile_2),
    notes: mergeNotes(acc.notes, incoming.notes),
    source: sources[sources.length - 1] ?? acc.source ?? incoming.source,
    sources_used: sources,
    source_count: sources.length,
  };
}

/**
 * City is master. State/country come from verified resolver when incoming city resolves.
 * Never overwrite existing geo with blank imports. Never trust imported state/country.
 */
export function mergeGeoFields(
  existing: { city?: string | null; state?: string | null; country?: string | null },
  incoming: ImportRow,
): { city: string | null; state: string | null; country: string | null } {
  const mergedCity = mergeFillMissing(existing.city, incoming.city);

  if (incoming._geoResolved && isMeaningful(incoming.city)) {
    return {
      city: mergedCity,
      state: incoming.state ?? null,
      country: incoming.country ?? null,
    };
  }

  if (isMeaningful(mergedCity) && isMeaningful(existing.city) && !isMeaningful(incoming.city)) {
    return {
      city: mergedCity,
      state: existing.state ?? null,
      country: existing.country ?? null,
    };
  }

  return {
    city: mergedCity,
    state: mergeFillMissing(existing.state, null),
    country: mergeFillMissing(existing.country, null),
  };
}

function mergeGeoCorrections(
  existing: MarketingAudience['geo_corrections'] | null | undefined,
  incoming: GeoCorrection[] | null | undefined,
): MarketingAudience['geo_corrections'] {
  const base = Array.isArray(existing) ? [...existing] : [];
  const add = Array.isArray(incoming) ? incoming.map(c => ({ ...c })) : [];
  return [...base, ...add];
}

function pickGeoQuality(
  existing: GeoQuality | string | null | undefined,
  incoming: GeoQuality | undefined,
  merged: { city: string | null; state: string | null; country: string | null },
  phone: string | null | undefined,
): GeoQuality {
  if (incoming) return incoming;
  if (existing === 'VALID' || existing === 'PARTIAL' || existing === 'JUNK') {
    if (
      isMeaningful(merged.city) &&
      isMeaningful(merged.state) &&
      isMeaningful(merged.country) &&
      isMeaningful(phone)
    ) {
      return 'VALID';
    }
    return existing as GeoQuality;
  }
  return 'PARTIAL';
}

/** Merge import row into an existing DB record — enrichment rules only. */
export function mergeIntoExisting(
  existing: MarketingAudience,
  incoming: ImportRow,
): Partial<MarketingAudience> {
  const sourceLabel = incoming.source ?? 'CSV Import';
  const sources = mergeSources(existing.sources_used, sourceLabel);
  const mergedName = mergeName(existing.name, incoming.name ?? incoming.customer_name);
  const mergedCustomerName = mergeName(existing.customer_name, incoming.customer_name ?? incoming.name);
  const geo = mergeGeoFields(existing, incoming);

  const patch: Partial<MarketingAudience> = {
    name: mergedName,
    customer_name: mergedCustomerName,
    email: mergeEmail(existing.email, incoming.email),
    city: geo.city,
    state: geo.state,
    country: geo.country,
    company: mergeFillMissing(existing.company, incoming.company),
    gst: mergeFillMissing(existing.gst, incoming.gst),
    business_type: mergeFillMissing(existing.business_type, incoming.business_type),
    address: mergeFillMissing(existing.address, incoming.address),
    mobile_2: mergeFillMissing(existing.mobile_2, incoming.mobile_2),
    notes: mergeNotes(existing.notes, incoming.notes),
    sources_used: sources,
    source_count: sources.length,
    source: sources[sources.length - 1] ?? existing.source,
    last_enriched_at: new Date(),
    geo_corrections: mergeGeoCorrections(existing.geo_corrections, incoming._geoCorrections),
    geo_source: incoming._geoResolved ? (incoming._geoSource ?? existing.geo_source) : existing.geo_source,
    geo_resolved_at: incoming._geoResolved ? new Date() : existing.geo_resolved_at,
    geo_quality: pickGeoQuality(existing.geo_quality, incoming._geoQuality, geo, existing.phone),
  };

  patch.contact_strength = computeContactStrength({
    phone: existing.phone,
    name: patch.name ?? existing.name,
    customer_name: patch.customer_name ?? existing.customer_name,
    email: patch.email ?? existing.email,
    city: patch.city ?? existing.city,
    business_type: patch.business_type ?? existing.business_type,
  });

  return patch;
}

/** Collapse duplicate phones within a batch — merge data, do not drop. */
export function collapseBatchByPhone(
  rows: ImportRow[],
  normalizePhone: (raw: string) => string | null,
): { merged: ImportRow[]; duplicatesMerged: number } {
  const byPhone = new Map<string, ImportRow>();
  let duplicatesMerged = 0;

  for (const row of rows) {
    const phone = normalizePhone(row.phone!);
    if (!phone) continue;
    const normalized: ImportRow = {
      ...row,
      phone,
      source: row.source ?? 'CSV Import',
      sources_used: mergeSources([], row.source ?? 'CSV Import'),
      source_count: 1,
    };
    if (byPhone.has(phone)) {
      byPhone.set(phone, mergeImportRows(byPhone.get(phone)!, normalized));
      duplicatesMerged++;
    } else {
      byPhone.set(phone, normalized);
    }
  }

  return { merged: [...byPhone.values()], duplicatesMerged };
}

export function buildNewContactRow(
  incoming: ImportRow,
  qualityScore: number,
): Partial<MarketingAudience> {
  const sources = mergeSources([], incoming.source ?? 'CSV Import');
  const name = mergeName(incoming.name, incoming.customer_name);
  const geo = mergeGeoFields({}, incoming);
  return {
    ...incoming,
    phone: incoming.phone,
    name,
    customer_name: mergeName(incoming.customer_name, incoming.name) ?? name,
    email: mergeEmail(null, incoming.email),
    city: geo.city,
    state: geo.state,
    country: geo.country,
    geo_quality: incoming._geoQuality ?? 'PARTIAL',
    geo_source: incoming._geoSource ?? null,
    geo_resolved_at: incoming._geoResolved ? new Date() : null,
    geo_corrections: incoming._geoCorrections ?? [],
    company: mergeFillMissing(null, incoming.company),
    gst: mergeFillMissing(null, incoming.gst),
    business_type: mergeFillMissing(null, incoming.business_type),
    address: mergeFillMissing(null, incoming.address),
    mobile_2: mergeFillMissing(null, incoming.mobile_2),
    notes: mergeNotes(null, incoming.notes),
    sources_used: sources,
    source_count: sources.length,
    source: sources[sources.length - 1] ?? 'CSV Import',
    quality_score: qualityScore,
    contact_strength: computeContactStrength({ ...incoming, name }),
    last_enriched_at: new Date(),
    duplicate_status: null,
    duplicate_email_phone: null,
    merge_suggestion: null,
  };
}

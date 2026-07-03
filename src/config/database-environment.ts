import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { sanitizeDatabaseUrl, redactDatabaseUrl } from '../utils/db-url.util';

export type EnvironmentLabel = 'LOCAL' | 'PRODUCTION' | 'TEST' | 'UNKNOWN';

export type EnvironmentIsolationStatus = 'PASS' | 'WARN' | 'FAIL';
export type OverwriteRisk = 'LOW' | 'MEDIUM' | 'HIGH';

/** Hardcoded production Neon host — always used as fingerprint fallback. */
export const PRODUCTION_DB_HOST_FALLBACK =
  'ep-noisy-pond-a1nmenkk-pooler.ap-southeast-1.aws.neon.tech';

export type DatabaseEnvironmentSnapshot = {
  node_env: string;
  environment: EnvironmentLabel;
  database_status: 'CONNECTED' | 'DISCONNECTED';
  database_host: string;
  database_name: string;
  database_url_redacted: string;
  is_production_target: boolean;
  customer_db_count: number | null;
  promotional_db_count: number | null;
  import_protection: string;
  audit: {
    local_database_redacted: string | null;
    production_database_redacted: string | null;
    isolation_status: EnvironmentIsolationStatus;
    overwrite_risk: OverwriteRisk;
    overwrite_risk_reason: string;
  };
};

const LOCAL_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.0\.0\.1$/,
  /^0\.0\.0\.0$/,
  /\.local$/i,
];

const TEST_HOST_PATTERNS = [/test/i, /staging/i, /preview/i, /sandbox/i];

/** Production Neon host — env override, then hardcoded fallback. */
export function productionHostFingerprint(): string {
  const explicit = (process.env.PRODUCTION_DB_HOST || '').trim();
  if (explicit) return explicit;
  return PRODUCTION_DB_HOST_FALLBACK;
}

function parseDbUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(sanitizeDatabaseUrl(raw));
    return {
      host: u.hostname,
      database: u.pathname.replace(/^\//, '') || 'unknown',
    };
  } catch {
    return { host: 'unknown', database: 'unknown' };
  }
}

function hostMatchesProduction(host: string): boolean {
  const prodFp = productionHostFingerprint();
  if (
    prodFp &&
    (host === prodFp || host.includes(prodFp) || prodFp.includes(host))
  ) {
    return true;
  }
  const prodUrl = (process.env.PRODUCTION_DATABASE_URL || '').trim();
  if (prodUrl) {
    const prodHost = parseDbUrl(prodUrl).host;
    if (
      prodHost !== 'unknown' &&
      (host === prodHost || host.includes(prodHost) || prodHost.includes(host))
    ) {
      return true;
    }
  }
  return false;
}

function classifyHost(host: string): EnvironmentLabel {
  if (!host || host === 'unknown') return 'UNKNOWN';
  if (LOCAL_HOST_PATTERNS.some((p) => p.test(host))) return 'LOCAL';
  if (TEST_HOST_PATTERNS.some((p) => p.test(host))) return 'TEST';

  if (hostMatchesProduction(host)) return 'PRODUCTION';
  if (/neon\.tech/i.test(host)) return 'LOCAL';

  return 'UNKNOWN';
}

export function isProductionDatabaseUrl(url: string): boolean {
  return classifyHost(parseDbUrl(url).host) === 'PRODUCTION';
}

export function isLocalOrTestDatabaseUrl(url: string): boolean {
  const label = classifyHost(parseDbUrl(url).host);
  return label === 'LOCAL' || label === 'TEST';
}

/**
 * Resolve the active database URL.
 * LOCAL (NODE_ENV != production): LOCAL_DATABASE_URL required — no DATABASE_URL fallback.
 * PRODUCTION (NODE_ENV = production): DATABASE_URL required.
 */
export function resolveDatabaseUrl(): string {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const url = (process.env.DATABASE_URL || '').trim();
    if (!url) {
      throw new Error(
        'FATAL: Production requires DATABASE_URL. Refusing to start.',
      );
    }
    if (isLocalOrTestDatabaseUrl(url)) {
      throw new Error(
        'FATAL: Production NODE_ENV cannot use a local/test database URL. Refusing to start.',
      );
    }
    if (!hostMatchesProduction(parseDbUrl(url).host)) {
      throw new Error(
        `FATAL: Production DATABASE_URL host does not match production fingerprint ` +
          `(${productionHostFingerprint()}). Refusing to start.`,
      );
    }
    return sanitizeDatabaseUrl(url);
  }

  const local = (process.env.LOCAL_DATABASE_URL || '').trim();
  if (!local) {
    throw new Error(
      'FATAL: Local development requires LOCAL_DATABASE_URL. ' +
        'DATABASE_URL fallback is disabled. Refusing to start.',
    );
  }
  if (isProductionDatabaseUrl(local)) {
    throw new Error(
      'FATAL: LOCAL_DATABASE_URL points to production. Use a dev/staging Neon branch or local Postgres.',
    );
  }
  return sanitizeDatabaseUrl(local);
}

/** Call at startup after resolveDatabaseUrl — hard stop on unsafe binding. */
export function assertSafeDatabaseBinding(resolvedUrl: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  const label = classifyHost(parseDbUrl(resolvedUrl).host);

  if (!isProd && label === 'PRODUCTION') {
    throw new Error(
      'FATAL: Environment isolation violation — local server bound to PRODUCTION database.',
    );
  }
  if (isProd && (label === 'LOCAL' || label === 'TEST')) {
    throw new Error(
      'FATAL: Environment isolation violation — production server bound to LOCAL/TEST database.',
    );
  }
}

export function getActiveDatabaseUrl(): string {
  return process.env.DATABASE_URL || resolveDatabaseUrl();
}

function redactConfiguredUrl(raw: string | undefined): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  try {
    return redactDatabaseUrl(sanitizeDatabaseUrl(trimmed));
  } catch {
    return '(invalid url)';
  }
}

export function buildEnvironmentAudit(
  activeUrl: string,
): DatabaseEnvironmentSnapshot['audit'] {
  const localRaw = (process.env.LOCAL_DATABASE_URL || '').trim();
  const prodRaw = (
    process.env.PRODUCTION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();
  const isProdNode = process.env.NODE_ENV === 'production';
  const activeLabel = classifyHost(parseDbUrl(activeUrl).host);
  const prodFp = productionHostFingerprint();

  const localRedacted = redactConfiguredUrl(localRaw);
  const prodRedacted =
    redactConfiguredUrl(prodRaw) || `postgresql://***@${prodFp}/***`;

  let isolation_status: EnvironmentIsolationStatus = 'PASS';
  let overwrite_risk: OverwriteRisk = 'LOW';
  let overwrite_risk_reason =
    'Active binding matches NODE_ENV; local and production URLs are separated.';

  if (!isProdNode && activeLabel === 'PRODUCTION') {
    isolation_status = 'FAIL';
    overwrite_risk = 'HIGH';
    overwrite_risk_reason =
      'Development server is connected to the production database.';
  } else if (
    isProdNode &&
    (activeLabel === 'LOCAL' || activeLabel === 'TEST')
  ) {
    isolation_status = 'FAIL';
    overwrite_risk = 'HIGH';
    overwrite_risk_reason =
      'Production server is connected to a local/test database.';
  } else if (!localRaw && !isProdNode) {
    isolation_status = 'FAIL';
    overwrite_risk = 'HIGH';
    overwrite_risk_reason =
      'LOCAL_DATABASE_URL is required for development — no DATABASE_URL fallback.';
  }

  return {
    local_database_redacted: localRedacted,
    production_database_redacted: prodRedacted,
    isolation_status,
    overwrite_risk,
    overwrite_risk_reason,
  };
}

export function buildEnvironmentSnapshot(
  connected: boolean,
  counts?: { customer: number; promotional: number },
): DatabaseEnvironmentSnapshot {
  const url = getActiveDatabaseUrl();
  const { host, database } = parseDbUrl(url);
  const environment = classifyHost(host);
  const isProd = process.env.NODE_ENV === 'production';

  let import_protection = 'Standard';
  if (!isProd && environment === 'PRODUCTION') {
    import_protection = 'BLOCKED — dev server on production DB';
  } else if (environment === 'PRODUCTION') {
    import_protection = 'Production writes require confirm_production';
  } else {
    import_protection = 'Local/dev — production writes blocked from this DB';
  }

  return {
    node_env: process.env.NODE_ENV || 'development',
    environment,
    database_status: connected ? 'CONNECTED' : 'DISCONNECTED',
    database_host: host,
    database_name: database,
    database_url_redacted: redactDatabaseUrl(url),
    is_production_target: environment === 'PRODUCTION',
    customer_db_count: counts?.customer ?? null,
    promotional_db_count: counts?.promotional ?? null,
    import_protection,
    audit: buildEnvironmentAudit(url),
  };
}

/** Guard all promotional contact writes — throws if write not allowed. */
export function assertPromotionalWriteAllowed(
  confirmProduction: boolean,
): void {
  const url = getActiveDatabaseUrl();
  const environment = classifyHost(parseDbUrl(url).host);
  const isProdNode = process.env.NODE_ENV === 'production';

  if (!isProdNode && environment === 'PRODUCTION') {
    throw new ForbiddenException(
      'Promotional write blocked: non-production server is connected to the production database. ' +
        'Set LOCAL_DATABASE_URL to a dev database.',
    );
  }

  if (environment === 'PRODUCTION' && !confirmProduction) {
    throw new BadRequestException(
      'Production promotional write requires confirm_production: true in the request.',
    );
  }
}

/** @deprecated Use assertPromotionalWriteAllowed */
export const assertPromotionalImportAllowed = assertPromotionalWriteAllowed;

/** Used by deploy scripts — returns 0 if URL looks like production. */
export function validateProductionDatabaseUrl(url: string): {
  ok: boolean;
  reason: string;
} {
  const trimmed = (url || '').trim();
  if (!trimmed) return { ok: false, reason: 'DATABASE_URL missing' };

  const { host } = parseDbUrl(trimmed);
  if (LOCAL_HOST_PATTERNS.some((p) => p.test(host))) {
    return { ok: false, reason: `Local database host detected: ${host}` };
  }
  if (TEST_HOST_PATTERNS.some((p) => p.test(host))) {
    return {
      ok: false,
      reason: `Test/staging database host detected: ${host}`,
    };
  }

  if (!hostMatchesProduction(host)) {
    return {
      ok: false,
      reason: `Host ${host} does not match production fingerprint`,
    };
  }

  return { ok: true, reason: `Production database verified: ${host}` };
}

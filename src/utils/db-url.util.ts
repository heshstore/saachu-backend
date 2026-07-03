/**
 * Strips connection-string parameters that pg / TypeORM don't implement.
 *
 * Neon pooler URLs include `channel_binding=require` which demands
 * SCRAM-SHA-256-PLUS (TLS channel binding).  Neither pg.Client nor TypeORM's
 * underlying pg.Pool support it, so authentication fails with "password
 * authentication failed" even when the password is correct.
 *
 * sslmode=require is preserved — it is handled at the TCP layer and works fine.
 */
export function sanitizeDatabaseUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch {
    // Fallback: regex strip in case URL() can't parse (e.g. bare postgres:// with no host)
    return raw.replace(/[?&]channel_binding=[^&]*/g, '').replace(/[?&]$/, '');
  }
}

/** True when the URL indicates a cloud-hosted DB that requires TLS. */
export function requiresSsl(url: string): boolean {
  return /neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(
    url,
  );
}

/** Returns the pg ssl option, or false for local DBs. */
export function buildSslOption(
  url: string,
): { rejectUnauthorized: boolean } | false {
  return requiresSsl(url) ? { rejectUnauthorized: false } : false;
}

/** Redact the password for safe logging — keeps host + params visible. */
export function redactDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@');
}

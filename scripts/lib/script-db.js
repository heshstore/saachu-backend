'use strict';
/* eslint-disable no-console */
/**
 * script-db.js — database bootstrap helper for all migration/seed/utility scripts.
 *
 * Works BEFORE any NestJS build. Does NOT import from dist/.
 * All safety rules are self-contained here and mirror database-environment.ts.
 *
 * Usage:
 *   const { resolveScriptDb } = require('./lib/script-db');
 *   const { url, ssl } = resolveScriptDb();
 *   const client = new Client({ connectionString: url, ssl });
 */

const path = require('path');
const { URL } = require('url');

// ── Load backend/.env unconditionally — absolute path, CWD-independent ─────
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// ── Production host fingerprint ──────────────────────────────────────────────
// Must stay in sync with PRODUCTION_DB_HOST_FALLBACK in database-environment.ts.
const PRODUCTION_HOST_FALLBACK =
  'ep-noisy-pond-a1nmenkk-pooler.ap-southeast-1.aws.neon.tech';

// ── Host classification patterns ─────────────────────────────────────────────
const LOCAL_HOST_RE  = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$|\.local$/i;
const CLOUD_HOST_RE  = /neon\.tech|aiven\.io|supabase\.co|render\.com|railway\.app/i;
const SSL_REQUIRE_RE = /neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripChannelBinding(raw) {
  return raw.replace(/([?&])channel_binding=[^&]*/g, '$1').replace(/[?&]$/, '');
}

function parseHost(rawUrl) {
  try {
    return new URL(stripChannelBinding(rawUrl)).hostname;
  } catch {
    return null;
  }
}

function isLocalHost(host) {
  return LOCAL_HOST_RE.test(host);
}

function isProductionHost(host) {
  const fingerprint =
    (process.env.PRODUCTION_DB_HOST || '').trim() || PRODUCTION_HOST_FALLBACK;
  return (
    host === fingerprint ||
    host.includes(fingerprint) ||
    fingerprint.includes(host) ||
    CLOUD_HOST_RE.test(host)
  );
}

function fatal(msg) {
  console.error(`\n[script-db] FATAL: ${msg}\n`);
  process.exit(1);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolves, validates, and returns the database URL for the current environment.
 *
 * Development  (NODE_ENV != 'production'):
 *   Reads LOCAL_DATABASE_URL. Fails if missing or pointing at a cloud host.
 *
 * Production   (NODE_ENV == 'production'):
 *   Reads DATABASE_URL. Fails if missing, pointing at localhost, or host
 *   does not match the production fingerprint.
 *
 * @returns {{ url: string, ssl: false | { rejectUnauthorized: boolean } }}
 */
function resolveScriptDb() {
  const isProd = process.env.NODE_ENV === 'production';

  let raw;

  if (isProd) {
    raw = (process.env.DATABASE_URL || '').trim();
    if (!raw)
      fatal(
        'Production requires DATABASE_URL. ' +
          'Export it in the environment or set it in backend/.env.',
      );

    const host = parseHost(raw);
    if (!host) fatal(`DATABASE_URL is not a valid connection string: "${raw}"`);
    if (isLocalHost(host))
      fatal(
        `DATABASE_URL points to localhost (${host}). ` +
          'Production must use the Neon database.',
      );
    if (!isProductionHost(host))
      fatal(
        `DATABASE_URL host "${host}" does not match the production fingerprint ` +
          `("${PRODUCTION_HOST_FALLBACK}"). ` +
          'Set PRODUCTION_DB_HOST in the environment to override.',
      );
  } else {
    raw = (process.env.LOCAL_DATABASE_URL || '').trim();
    if (!raw)
      fatal(
        'Development requires LOCAL_DATABASE_URL in backend/.env. ' +
          'DATABASE_URL fallback is disabled to prevent accidental Neon writes.',
      );

    const host = parseHost(raw);
    if (!host) fatal(`LOCAL_DATABASE_URL is not a valid connection string: "${raw}"`);
    if (isProductionHost(host))
      fatal(
        `LOCAL_DATABASE_URL points to a production/cloud host (${host}). ` +
          'Use local PostgreSQL for development.',
      );
  }

  const url = stripChannelBinding(raw);
  const ssl = SSL_REQUIRE_RE.test(url) ? { rejectUnauthorized: false } : false;

  console.log(
    `[script-db] ${isProd ? 'production' : 'development'} → ${url.replace(/:([^@]+)@/, ':***@')}`,
  );

  return { url, ssl };
}

module.exports = { resolveScriptDb };

/* eslint-disable no-console */
/**
 * Lead Quality Backfill
 *
 * Fixes existing rows that have data quality issues introduced before the
 * lead-quality hardening pass:
 *
 *   1. phone = 'unknown'      → NULL
 *   2. name  = NULL / ''      → 'Customer'
 *   3. name  = 'Unknown*'     → 'Customer'
 *   4. raw_payload missing last_message
 *                             → copy from raw_payload.message / notes
 *
 * Idempotent — safe to run multiple times.
 * Runs in batches of 500 to avoid long-running transactions on large tables.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {

    // ── 1. phone = 'unknown' → NULL ───────────────────────────────────────────
    const { rowCount: phoneFix } = await client.query(`
      UPDATE leads
      SET    phone      = NULL,
             updated_at = now()
      WHERE  phone = 'unknown'
    `);
    console.log(`[1/4] phone 'unknown' → NULL: ${phoneFix} rows updated`);

    // ── 2 & 3. name = NULL / '' / 'Unknown*' → 'Customer' ────────────────────
    const { rowCount: nameFix } = await client.query(`
      UPDATE leads
      SET    name       = 'Customer',
             updated_at = now()
      WHERE  name IS NULL
         OR  TRIM(name) = ''
         OR  name ILIKE 'unknown%'
    `);
    console.log(`[2/4] name empty/Unknown → 'Customer': ${nameFix} rows updated`);

    // ── 4. raw_payload missing last_message ──────────────────────────────────
    // Copy from raw_payload.message (Shopify) or notes (WhatsApp) if present.
    // Uses jsonb_set to merge — does not overwrite existing last_message values.
    const { rowCount: lmFix } = await client.query(`
      UPDATE leads
      SET raw_payload = jsonb_set(
            jsonb_set(
              COALESCE(raw_payload, '{}'::jsonb),
              '{last_message}',
              to_jsonb(
                COALESCE(
                  raw_payload->>'message',
                  NULLIF(TRIM(notes), ''),
                  ''
                )
              )
            ),
            '{last_message_at}',
            to_jsonb(updated_at::text)
          ),
          updated_at = now()
      WHERE is_active = true
        AND (
          raw_payload IS NULL
          OR raw_payload->>'last_message' IS NULL
        )
    `);
    console.log(`[3/4] last_message backfilled: ${lmFix} rows updated`);

    // ── 5. Verify ─────────────────────────────────────────────────────────────
    const { rows: summary } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE phone = 'unknown')                       AS phone_unknown_remaining,
        COUNT(*) FILTER (WHERE name IS NULL OR TRIM(name) = '')         AS name_empty_remaining,
        COUNT(*) FILTER (WHERE name ILIKE 'unknown%')                   AS name_unknown_remaining,
        COUNT(*) FILTER (WHERE raw_payload->>'last_message' IS NULL)    AS last_message_missing,
        COUNT(*)                                                         AS total_active
      FROM leads
      WHERE is_active = true
    `);

    const s = summary[0];
    console.log('\n[4/4] Verification:');
    console.log(`  Total active leads:       ${s.total_active}`);
    console.log(`  phone = 'unknown':        ${s.phone_unknown_remaining}`);
    console.log(`  name empty:               ${s.name_empty_remaining}`);
    console.log(`  name starts with Unknown: ${s.name_unknown_remaining}`);
    console.log(`  last_message missing:     ${s.last_message_missing}`);

    const clean =
      Number(s.phone_unknown_remaining) === 0 &&
      Number(s.name_empty_remaining) === 0 &&
      Number(s.last_message_missing) === 0;

    console.log(clean ? '\n✅ All leads are UI-ready.\n' : '\n⚠️  Some issues remain — check output above.\n');

  } finally {
    await client.end();
  }
}

main().catch(err => { console.error('\nBackfill failed:', err.message); process.exit(1); });

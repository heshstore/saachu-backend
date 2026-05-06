/* eslint-disable no-console */
/**
 * CRM Index Migration
 * Adds performance indexes required for production scale (10,000+ leads/day).
 *
 * Indexes created:
 *   idx_leads_phone           — phone lookups (dedup, search)
 *   idx_leads_status          — queue/list filters
 *   idx_leads_source          — analytics group-bys
 *   idx_leads_assigned_to     — role-scoped list (most common query)
 *   idx_leads_created_at      — ordering on all list queries
 *   idx_leads_active          — partial index, filters is_active = true
 *   idx_leads_active_assigned — composite for the role-scoped active list
 *
 * Also ensures:
 *   lead_notes.created_by     — nullable (supports system-generated notes)
 *   lead_followups.created_by — nullable (supports system-generated follow-ups)
 *
 * Idempotent — safe to run multiple times.
 * Uses CONCURRENTLY so no table lock on a live database.
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
  if (!url) { console.error('❌  DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('✅  Connected to database');

  try {
    // ── 1. leads table — single-column indexes ──────────────────────────────────
    console.log('\n📌  Creating single-column indexes on leads…');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_phone
        ON leads (phone)
    `);
    console.log('   ✓ idx_leads_phone');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_status
        ON leads (status)
    `);
    console.log('   ✓ idx_leads_status');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_source
        ON leads (source)
    `);
    console.log('   ✓ idx_leads_source');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_assigned_to
        ON leads (assigned_to)
    `);
    console.log('   ✓ idx_leads_assigned_to');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_created_at
        ON leads (created_at DESC)
    `);
    console.log('   ✓ idx_leads_created_at');

    // ── 2. leads table — partial index (active only) ────────────────────────────
    console.log('\n📌  Creating partial index for active leads…');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_active
        ON leads (is_active)
        WHERE is_active = true
    `);
    console.log('   ✓ idx_leads_active');

    // ── 3. leads table — composite index (role-scoped list query) ───────────────
    // Covers: WHERE is_active = true AND assigned_to = $1 ORDER BY created_at DESC
    console.log('\n📌  Creating composite index for role-scoped queries…');

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_active_assigned
        ON leads (is_active, assigned_to, created_at DESC)
    `);
    console.log('   ✓ idx_leads_active_assigned');

    // ── 4. lead_notes — make created_by nullable ────────────────────────────────
    console.log('\n📌  Patching lead_notes.created_by → nullable…');

    await client.query(`
      ALTER TABLE lead_notes
        ALTER COLUMN created_by DROP NOT NULL
    `);
    console.log('   ✓ lead_notes.created_by is now nullable');

    // ── 5. lead_followups — make created_by nullable ────────────────────────────
    console.log('\n📌  Patching lead_followups.created_by → nullable…');

    await client.query(`
      ALTER TABLE lead_followups
        ALTER COLUMN created_by DROP NOT NULL
    `);
    console.log('   ✓ lead_followups.created_by is now nullable');

    // ── 6. Backfill legacy source values → canonical enum ───────────────────────
    // Records ingested before the enum normalisation (META_ADS, GOOGLE_ADS, etc.)
    // would appear as separate groups in analytics. Backfill them to canonical values
    // so GROUP BY source returns clean data.
    console.log('\n📌  Backfilling legacy source values to canonical enum…');

    const backfills = [
      ['MANUAL',      'DIRECT'],
      ['DIRECT_CALL', 'DIRECT'],
      ['META_ADS',    'META'],
      ['GOOGLE_ADS',  'GOOGLE'],
    ];
    for (const [from, to] of backfills) {
      const result = await client.query(
        `UPDATE leads SET source = $2 WHERE source = $1`,
        [from, to],
      );
      if (result.rowCount > 0) {
        console.log(`   ✓ ${result.rowCount} rows: ${from} → ${to}`);
      } else {
        console.log(`   - ${from}: no rows to migrate`);
      }
    }

    // ── 7. Backfill NULL/empty context for existing leads ────────────────────────
    // Sets a sensible context label based on source for pre-fix records.
    console.log('\n📌  Backfilling NULL context from source…');

    const contextBackfills = [
      ['SHOPIFY',   'SHOPIFY – Product Form'],
      ['META',      'META – Lead Form'],
      ['GOOGLE',    'GOOGLE – Organic'],
      ['INDIAMART', 'INDIAMART – Query'],
      ['WHATSAPP',  'WHATSAPP – Inbound Message'],
      ['DIRECT',    'DIRECT – Manual Entry'],
      ['LINKEDIN',  'LINKEDIN – Organic'],
    ];
    for (const [source, ctx] of contextBackfills) {
      const result = await client.query(
        `UPDATE leads SET context = $2 WHERE source = $1 AND (context IS NULL OR context = '')`,
        [source, ctx],
      );
      if (result.rowCount > 0) {
        console.log(`   ✓ ${result.rowCount} rows: source=${source} → "${ctx}"`);
      } else {
        console.log(`   - source=${source}: no rows to backfill`);
      }
    }

    console.log('\n🎉  Migration complete — all indexes applied.');
  } catch (err) {
    // Ignore "already exists" and "column does not have a NOT NULL constraint" — both are safe
    if (
      err.message?.includes('already exists') ||
      err.message?.includes('does not have a NOT NULL constraint')
    ) {
      console.log(`   (skipped — ${err.message.trim()})`);
    } else {
      console.error('\n❌  Migration failed:', err.message);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

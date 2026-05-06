/* eslint-disable no-console */
/**
 * Lead Alerts Patch Migration
 *
 * Fixes schema gaps in the lead_alerts table:
 *   - Creates table if it does not exist (full schema)
 *   - Makes lead_id nullable (system-level alerts have no lead)
 *   - Adds resolved, updated_at, alert_type columns if missing
 *   - Creates required indexes
 *
 * Idempotent — safe to run multiple times.
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

async function run(client, label, sql) {
  try {
    await client.query(sql);
    console.log(`  ✅ ${label}`);
  } catch (err) {
    // 42701 = column already exists, 42P07 = index/relation already exists, 42710 = constraint already exists
    if (['42701', '42P07', '42710'].includes(err.code)) {
      console.log(`  ⏭  ${label} (already exists — skipped)`);
    } else {
      console.error(`  ❌ ${label}: ${err.message} (code: ${err.code})`);
      throw err;
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {

    // ── 1. Create table with full schema (no-op if already exists) ────────────
    await run(client, 'create lead_alerts table', `
      CREATE TABLE IF NOT EXISTS lead_alerts (
        id         SERIAL PRIMARY KEY,
        lead_id    INT          REFERENCES leads(id) ON DELETE CASCADE,
        type       VARCHAR(50)  NOT NULL,
        message    TEXT         NOT NULL,
        resolved   BOOLEAN      NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // ── 2. Patch columns that may be missing on tables created by older migration ─

    // lead_id: drop NOT NULL if it was created as NOT NULL (allow system-level alerts)
    try {
      await client.query(`ALTER TABLE lead_alerts ALTER COLUMN lead_id DROP NOT NULL`);
      console.log('  ✅ lead_id made nullable');
    } catch (err) {
      // 42704 = constraint does not exist (already nullable)
      if (err.code === '42704' || err.message.includes('does not exist')) {
        console.log('  ⏭  lead_id already nullable — skipped');
      } else {
        throw err;
      }
    }

    await run(client, 'add resolved column',
      `ALTER TABLE lead_alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT false`);

    await run(client, 'add updated_at column',
      `ALTER TABLE lead_alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

    // ── 3. Indexes ─────────────────────────────────────────────────────────────

    await run(client, 'index on lead_id',
      `CREATE INDEX IF NOT EXISTS idx_lead_alerts_lead_id ON lead_alerts(lead_id)`);

    await run(client, 'index on resolved',
      `CREATE INDEX IF NOT EXISTS idx_lead_alerts_resolved ON lead_alerts(resolved) WHERE resolved = false`);

    await run(client, 'composite index for unresolved alerts per lead+type',
      `CREATE INDEX IF NOT EXISTS idx_lead_alerts_unresolved ON lead_alerts(lead_id, type) WHERE resolved = false`);

    // ── 4. Verify ──────────────────────────────────────────────────────────────
    const { rows: cols } = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'lead_alerts'
      ORDER BY ordinal_position
    `);
    console.log('\n  lead_alerts columns:');
    cols.forEach(r =>
      console.log(`    ${r.column_name.padEnd(15)} ${r.data_type.padEnd(20)} nullable=${r.is_nullable} default=${r.column_default ?? 'none'}`),
    );

    const { rows: idxs } = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'lead_alerts'
      ORDER BY indexname
    `);
    console.log(`\n  Indexes (${idxs.length}):`);
    idxs.forEach(r => console.log(`    ${r.indexname}`));

    console.log('\n✅ lead_alerts patch complete.\n');

  } finally {
    await client.end();
  }
}

main().catch(err => { console.error('\nMigration failed:', err.message); process.exit(1); });

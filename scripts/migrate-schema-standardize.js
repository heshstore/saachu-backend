/* eslint-disable no-console */
/**
 * Schema Standardization Migration
 *
 * leads             — add context, requirement_note, UNIQUE(external_id)
 * analytics_events  — add device, city, source, timestamp; widen session_id/event to TEXT
 * promotion_contacts — add tag, make source/page_url nullable, add UNIQUE partial indexes
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
    // 42701 = column already exists, 42P07 = index/relation already exists
    if (['42701', '42P07', '23505', '42710'].includes(err.code)) {
      console.log(`  ⏭  ${label} (already exists)`);
    } else {
      console.error(`  ❌ ${label}: ${err.message}`);
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

    // ── 1. LEADS ─────────────────────────────────────────────────────────────────
    console.log('\n[leads]');

    await run(client, 'add context',
      `ALTER TABLE leads ADD COLUMN context TEXT`);

    await run(client, 'add requirement_note',
      `ALTER TABLE leads ADD COLUMN requirement_note TEXT`);

    // Deduplicate before adding UNIQUE — keep earliest row per external_id
    await run(client, 'dedup external_id before unique constraint', `
      DELETE FROM leads
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY external_id ORDER BY id ASC) AS rn
          FROM leads
          WHERE external_id IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `);

    await run(client, 'unique partial index on external_id',
      `CREATE UNIQUE INDEX idx_leads_external_id
         ON leads(external_id)
         WHERE external_id IS NOT NULL`);


    // ── 2. ANALYTICS_EVENTS ───────────────────────────────────────────────────────
    console.log('\n[analytics_events]');

    // Widen VARCHAR columns to TEXT (no-op if already TEXT; safe in Postgres)
    await run(client, 'widen session_id to TEXT',
      `ALTER TABLE analytics_events ALTER COLUMN session_id TYPE TEXT`);

    await run(client, 'widen event to TEXT',
      `ALTER TABLE analytics_events ALTER COLUMN event TYPE TEXT`);

    await run(client, 'widen product to TEXT',
      `ALTER TABLE analytics_events ALTER COLUMN product TYPE TEXT`);

    await run(client, 'add device',
      `ALTER TABLE analytics_events ADD COLUMN device TEXT`);

    await run(client, 'add city',
      `ALTER TABLE analytics_events ADD COLUMN city TEXT`);

    await run(client, 'add source',
      `ALTER TABLE analytics_events ADD COLUMN source TEXT`);

    await run(client, 'add timestamp',
      `ALTER TABLE analytics_events ADD COLUMN timestamp TIMESTAMP`);


    // ── 3. PROMOTION_CONTACTS ─────────────────────────────────────────────────────
    console.log('\n[promotion_contacts]');

    await run(client, 'add tag with default',
      `ALTER TABLE promotion_contacts ADD COLUMN tag TEXT DEFAULT 'promotion_capture'`);

    // Make source nullable — ALTER drops NOT NULL if it was set
    await run(client, 'make source nullable',
      `ALTER TABLE promotion_contacts ALTER COLUMN source DROP NOT NULL`);

    await run(client, 'make page_url nullable',
      `ALTER TABLE promotion_contacts ALTER COLUMN page_url DROP NOT NULL`);

    // Drop any old non-unique indexes before creating unique ones
    await client.query(`DROP INDEX IF EXISTS idx_promo_whatsapp`).catch(() => {});
    await client.query(`DROP INDEX IF EXISTS idx_promo_email`).catch(() => {});

    await run(client, 'unique partial index on whatsapp_number',
      `CREATE UNIQUE INDEX idx_promo_whatsapp
         ON promotion_contacts(whatsapp_number)
         WHERE whatsapp_number IS NOT NULL AND whatsapp_number <> ''`);

    await run(client, 'unique partial index on email',
      `CREATE UNIQUE INDEX idx_promo_email
         ON promotion_contacts(email)
         WHERE email IS NOT NULL AND email <> ''`);


    // ── VERIFY ────────────────────────────────────────────────────────────────────
    console.log('\n[verification]');

    const tables = ['leads', 'analytics_events', 'promotion_contacts'];
    for (const table of tables) {
      const { rows } = await client.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = $1
         ORDER BY ordinal_position`,
        [table],
      );
      console.log(`\n  ${table}:`);
      rows.forEach(r =>
        console.log(`    ${r.column_name.padEnd(20)} ${r.data_type.padEnd(18)} nullable=${r.is_nullable}`),
      );
    }

    console.log('\n✅ Schema standardization complete.\n');

  } finally {
    await client.end();
  }
}

main().catch(err => { console.error('\nMigration failed:', err.message); process.exit(1); });

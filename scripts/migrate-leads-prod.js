/* eslint-disable no-console */
/**
 * migrate-leads-prod.js
 *
 * Adds all columns that exist in the Lead entity but may be missing from the
 * production (Neon) database. Every statement uses IF NOT EXISTS — safe to
 * re-run as many times as needed, no data is modified.
 *
 * Usage:
 *   DATABASE_URL=<neon-url> node scripts/migrate-leads-prod.js
 *   -- OR --
 *   npm run migrate:leads-prod        (add script to package.json first)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const sslRequired =
  /neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(DATABASE_URL);

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('Connected to:', DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@'));

  try {
    // ── Step 1: confirm the leads table exists ─────────────────────────────────
    const { rows: tableCheck } = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'leads'
    `);
    if (tableCheck.length === 0) {
      console.error('ERROR: "leads" table does not exist in this database.');
      process.exit(1);
    }

    // ── Step 2: print current columns (before) ─────────────────────────────────
    const { rows: before } = await client.query(`
      SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'leads'
      ORDER BY ordinal_position
    `);
    console.log(`\nBEFORE: ${before.length} column(s) in leads table`);
    before.forEach(c => console.log(`  - ${c.column_name} (${c.data_type})`));

    // ── Step 3: add missing columns ────────────────────────────────────────────
    console.log('\nRunning migration...\n');

    const migrations = [
      { col: 'channel',           sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS channel           VARCHAR(20)`  },
      { col: 'lead_source_label', sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source_label VARCHAR(50)`  },
      { col: 'landing_page',      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS landing_page      TEXT`         },
      { col: 'city',              sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS city               TEXT`         },
      { col: 'state',             sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS state              TEXT`         },
      { col: 'country',           sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS country            TEXT`         },
      { col: 'requirement_note',  sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS requirement_note  TEXT`         },
      { col: 'tags',              sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags               JSONB NOT NULL DEFAULT '[]'::jsonb` },
    ];

    for (const { col, sql } of migrations) {
      await client.query(sql);
      console.log(`  ✓ ${col}`);
    }

    // ── Step 4: add indexes ────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads (channel)`);
    console.log('  ✓ index: idx_leads_channel');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_tags_gin ON leads USING GIN (tags)`);
    console.log('  ✓ index: idx_leads_tags_gin');

    // ── Step 5: verify all required columns are now present ───────────────────
    const required = [
      'id', 'name', 'phone', 'email', 'city', 'state', 'country',
      'source', 'status', 'assigned_to', 'notes', 'follow_up_date',
      'product_interest', 'requirement_note', 'utm_source', 'utm_campaign',
      'lead_priority', 'customer_id', 'quotation_id', 'whatsapp_chat_id',
      'raw_payload', 'external_id', 'lead_source_label', 'channel',
      'landing_page', 'duplicate_flag', 'tags', 'is_active',
      'created_by', 'created_at', 'updated_at',
    ];

    const { rows: after } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'leads'
    `);
    const present = new Set(after.map(r => r.column_name));
    const missing = required.filter(c => !present.has(c));

    if (missing.length > 0) {
      console.error(`\n  ✗ Still missing: ${missing.join(', ')}`);
      process.exit(1);
    }

    console.log(`\n  ✓ Verified: all ${required.length} required columns present`);
    console.log('\nMigration complete. No data was modified.');
  } finally {
    await client.end();
  }
}

main().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Template Offer Fields Migration
 *
 * Adds optional promotional offer support to marketing_templates.
 *
 *   offer_enabled    BOOLEAN      NOT NULL DEFAULT false
 *   offer_title      VARCHAR      nullable
 *   offer_text       TEXT         nullable
 *   offer_start_date TIMESTAMPTZ  nullable
 *   offer_end_date   TIMESTAMPTZ  nullable
 *
 * All columns default to disabled/null — zero impact on existing templates.
 * Idempotent — safe to run multiple times (ADD COLUMN IF NOT EXISTS).
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

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('Connected to database');

  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS offer_enabled BOOLEAN NOT NULL DEFAULT false
    `);
    console.log('✓ marketing_templates.offer_enabled');

    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS offer_title VARCHAR
    `);
    console.log('✓ marketing_templates.offer_title');

    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS offer_text TEXT
    `);
    console.log('✓ marketing_templates.offer_text');

    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS offer_start_date TIMESTAMPTZ
    `);
    console.log('✓ marketing_templates.offer_start_date');

    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS offer_end_date TIMESTAMPTZ
    `);
    console.log('✓ marketing_templates.offer_end_date');

    await client.query('COMMIT');
    console.log('\n✅ Migration complete — offer fields added to marketing_templates');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

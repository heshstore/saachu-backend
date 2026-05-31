/* eslint-disable no-console */
/**
 * Template Mode Migration
 *
 * Adds template_mode column to marketing_templates.
 *
 *   template_mode  VARCHAR  DEFAULT 'manual'
 *
 * Values: 'manual' (default) | 'ai'
 * All existing templates default to 'manual' — no data changes required.
 *
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
        ADD COLUMN IF NOT EXISTS template_mode VARCHAR NOT NULL DEFAULT 'manual'
    `);
    console.log("✓ marketing_templates.template_mode (default 'manual')");

    await client.query('COMMIT');
    console.log('\n✅ Migration complete — template_mode column added to marketing_templates');
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

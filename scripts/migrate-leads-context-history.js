/* eslint-disable no-console */
/**
 * Adds context_history TEXT column to leads table.
 *
 * Semantics:
 *   context         = latest touch-point label (single value)
 *   context_history = full pipe-separated journey
 *                     e.g. "META – Lead Form | SHOPIFY – WhatsApp Click"
 *
 * Backfill: seeds context_history from the existing context column so that
 * rows created before this migration still have a populated history.
 *
 * Idempotent — safe to re-run.
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

  // 1. Add context_history column
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS context_history TEXT;
  `);
  console.log('✓ Column context_history ensured');

  // 2. Backfill from context where context_history is still NULL
  const backfill = await client.query(`
    UPDATE leads
    SET context_history = context
    WHERE context_history IS NULL
      AND context IS NOT NULL;
  `);
  console.log(`✓ Backfilled context_history on ${backfill.rowCount} row(s)`);

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

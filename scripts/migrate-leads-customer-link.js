/* eslint-disable no-console */
/**
 * Adds customer linkage to leads table.
 *
 * - Ensures customer_id INT NULL column exists (may already be present).
 * - Creates idx_leads_customer_id for fast reverse lookups
 *   (quotation, orders, follow-ups all join on this).
 * - Backfills customer_id on existing leads whose phone is already registered
 *   in customer_phones.
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

  // 1. Ensure column exists (already present on most deployments)
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS customer_id INT NULL;
  `);
  console.log('✓ Column customer_id ensured');

  // 2. Index for fast join from orders / quotations / follow-ups
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_customer_id
      ON leads(customer_id)
      WHERE customer_id IS NOT NULL;
  `);
  console.log('✓ Index idx_leads_customer_id ensured');

  // 3. Backfill customer_id from customer_phones where phone matches
  const backfill = await client.query(`
    UPDATE leads l
    SET customer_id = cp.customer_id
    FROM customer_phones cp
    WHERE l.phone = cp.phone
      AND l.customer_id IS NULL
      AND l.phone IS NOT NULL;
  `);
  console.log(`✓ Backfilled customer_id on ${backfill.rowCount} lead(s)`);

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Leads table migration
 *
 * Adds:
 *   - idempotency_key VARCHAR(255)
 *   - updated_at TIMESTAMP DEFAULT now()
 *   - idx_leads_phone index on phone
 *   - idx_leads_idempotency index on idempotency_key
 *
 * Idempotent — safe to re-run.
 * CONCURRENTLY indexes avoid table locks on live data.
 * Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
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

  // 1. idempotency_key
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
  `);
  console.log('✓ Column idempotency_key ensured');

  // 2. updated_at
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();
  `);
  console.log('✓ Column updated_at ensured');

  // 3. Index on phone (CONCURRENTLY — no table lock)
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_phone
      ON leads(phone);
  `);
  console.log('✓ Index idx_leads_phone ensured');

  // 4. Index on idempotency_key (CONCURRENTLY — no table lock)
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_idempotency
      ON leads(idempotency_key);
  `);
  console.log('✓ Index idx_leads_idempotency ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

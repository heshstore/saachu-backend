/* eslint-disable no-console */
/**
 * Quotation table v2 migration
 *
 * Adds:
 *   - discount_type  VARCHAR(10) DEFAULT 'PERCENT'
 *   - discount_value NUMERIC(10,2) DEFAULT 0
 *   - updated_at     TIMESTAMP
 *
 * Migrates:
 *   - status 'OPEN' → 'DRAFT'
 *
 * Creates:
 *   - idx_quotation_customer ON quotation(customer_id)
 *   - idx_quotation_salesman ON quotation(salesman_id)
 *   - idx_quotation_status   ON quotation(status)
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

  // 1. Header-level discount columns
  await client.query(`
    ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(10) NOT NULL DEFAULT 'PERCENT',
      ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0;
  `);
  console.log('✓ Columns discount_type, discount_value ensured');

  // 2. updated_at
  await client.query(`
    ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
  `);
  console.log('✓ Column updated_at ensured');

  // 3. Migrate status: OPEN → DRAFT
  const migrated = await client.query(`
    UPDATE quotation SET status = 'DRAFT' WHERE status = 'OPEN';
  `);
  console.log(`✓ Migrated ${migrated.rowCount} row(s) from status OPEN → DRAFT`);

  // 4. Indexes (CONCURRENTLY — no table lock)
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotation_customer
      ON quotation(customer_id);
  `);
  console.log('✓ Index idx_quotation_customer ensured');

  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotation_salesman
      ON quotation(salesman_id);
  `);
  console.log('✓ Index idx_quotation_salesman ensured');

  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotation_status
      ON quotation(status);
  `);
  console.log('✓ Index idx_quotation_status ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

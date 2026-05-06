/* eslint-disable no-console */
/**
 * Creates the customer_phones index table for global phone uniqueness.
 *
 * One row = one phone = one customer.
 * Backfills from existing mobile1 and mobile2 columns.
 * Duplicate phones during backfill are skipped with a warning so the
 * migration stays idempotent even on dirty legacy data.
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

  // 1. Create customer_phones table
  await client.query(`
    CREATE TABLE IF NOT EXISTS customer_phones (
      id         SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
      phone      VARCHAR(20) NOT NULL,
      CONSTRAINT unique_customer_phone UNIQUE (phone)
    );
  `);
  console.log('✓ Table customer_phones ensured');

  // 2. Index on customer_id for fast reverse lookup
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_customer_phones_customer_id
      ON customer_phones(customer_id);
  `);
  console.log('✓ Index idx_customer_phones_customer_id ensured');

  // 3. Backfill from mobile1 — skip duplicates
  const mobile1Result = await client.query(`
    INSERT INTO customer_phones (customer_id, phone)
    SELECT id, mobile1
    FROM customer
    WHERE mobile1 IS NOT NULL
      AND mobile1 != ''
    ON CONFLICT (phone) DO NOTHING;
  `);
  console.log(`✓ Backfilled ${mobile1Result.rowCount} row(s) from mobile1`);

  // 4. Backfill from mobile2 — skip duplicates (phone already owned by mobile1 of same or another customer)
  const mobile2Result = await client.query(`
    INSERT INTO customer_phones (customer_id, phone)
    SELECT id, mobile2
    FROM customer
    WHERE mobile2 IS NOT NULL
      AND mobile2 != ''
    ON CONFLICT (phone) DO NOTHING;
  `);
  console.log(`✓ Backfilled ${mobile2Result.rowCount} row(s) from mobile2`);

  // 5. Report any mobile2 phones that were skipped due to conflict
  const conflicts = await client.query(`
    SELECT c.id AS customer_id, c.mobile2 AS phone, cp.customer_id AS owned_by
    FROM customer c
    JOIN customer_phones cp ON cp.phone = c.mobile2
    WHERE c.mobile2 IS NOT NULL
      AND cp.customer_id != c.id;
  `);
  if (conflicts.rows.length > 0) {
    console.warn(`\n⚠  ${conflicts.rows.length} mobile2 phone(s) already owned by another customer:`);
    conflicts.rows.forEach(r =>
      console.warn(`   customer_id=${r.customer_id} mobile2=${r.phone} → already owned by customer_id=${r.owned_by}`),
    );
    console.warn('   These phones were NOT inserted. Review and resolve manually.\n');
  }

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

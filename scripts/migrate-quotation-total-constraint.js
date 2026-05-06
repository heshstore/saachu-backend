/* eslint-disable no-console */
/**
 * Adds a CHECK constraint to quotation.total_amount to enforce non-negative totals
 * at the database level, independent of application-layer validation.
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

  // Check if any existing rows would violate the constraint before adding it.
  const { rows: violations } = await client.query(
    `SELECT id, quotation_no, total_amount FROM quotation WHERE total_amount < 0`,
  );
  if (violations.length > 0) {
    console.error(`Cannot add constraint — ${violations.length} row(s) have negative total_amount:`);
    violations.forEach(r => console.error(`  id=${r.id} ${r.quotation_no}: ${r.total_amount}`));
    process.exit(1);
  }

  // Add constraint only if it doesn't already exist.
  const { rows: existing } = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_quotation_total_non_negative'
      AND conrelid = 'quotation'::regclass
  `);

  if (existing.length > 0) {
    console.log('✓ Constraint chk_quotation_total_non_negative already exists — skipping');
  } else {
    await client.query(`
      ALTER TABLE quotation
        ADD CONSTRAINT chk_quotation_total_non_negative CHECK (total_amount >= 0)
    `);
    console.log('✓ Constraint chk_quotation_total_non_negative added');
  }

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

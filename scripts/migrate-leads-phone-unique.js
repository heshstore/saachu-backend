/* eslint-disable no-console */
/**
 * Adds a partial unique index on leads(phone) for active rows only.
 *
 * Pre-flight dedup steps (idempotent):
 *   1. NULL-out placeholder phone '0000000000' — not a real number.
 *   2. For each phone with multiple active rows: keep the oldest,
 *      soft-delete (is_active = false) the rest.
 *
 * The index covers only active rows so that soft-deleted leads never block
 * future re-creation for the same phone (e.g. returning customers).
 *
 * Idempotent — safe to re-run.
 * CONCURRENTLY avoids a table lock on live data.
 * Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
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

  // 1. NULL out placeholder phone — not a real contact
  const nulled = await client.query(`
    UPDATE leads SET phone = NULL WHERE phone = '0000000000';
  `);
  console.log(`✓ Nulled placeholder phone '0000000000' on ${nulled.rowCount} row(s)`);

  // 2. Soft-delete duplicate active rows — keep oldest per phone
  const deduped = await client.query(`
    UPDATE leads
    SET is_active = false
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at ASC) AS rn
        FROM leads
        WHERE phone IS NOT NULL
          AND is_active = true
      ) ranked
      WHERE rn > 1
    );
  `);
  console.log(`✓ Soft-deleted ${deduped.rowCount} duplicate active lead row(s)`);

  // 3. Partial unique index — active leads only; soft-deleted rows are excluded
  await client.query(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS unique_leads_phone_active
      ON leads(phone)
      WHERE phone IS NOT NULL AND is_active = true;
  `);
  console.log('✓ Partial unique index unique_leads_phone_active ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

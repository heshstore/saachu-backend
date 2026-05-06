/* eslint-disable no-console */
/**
 * Adds deleted_at TIMESTAMP NULL to the quotation table for soft-delete support.
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

  await client.query(`
    ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL;
  `);
  console.log('✓ Column deleted_at ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_quotation_deleted_at
      ON quotation(deleted_at)
      WHERE deleted_at IS NULL;
  `);
  console.log('✓ Index idx_quotation_deleted_at ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

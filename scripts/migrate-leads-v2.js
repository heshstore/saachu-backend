/* eslint-disable no-console */
/**
 * migrate-leads-v2.js
 * Adds: city, requirement_note, channel columns
 * Expands: phone VARCHAR(10) → VARCHAR(20)
 * Migrates: existing bare 10-digit phones → +91XXXXXXXXXX format
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    console.log('Running leads v2 migration...\n');

    // 1. Expand phone column so it fits +E.164 (up to 15 digits + '+' = 16 chars)
    await client.query(`ALTER TABLE leads ALTER COLUMN phone TYPE VARCHAR(20)`);
    console.log('  ✓ phone expanded to VARCHAR(20)');

    // 2. Migrate existing bare 10-digit phones to +91 prefix
    const { rowCount } = await client.query(`
      UPDATE leads
         SET phone = '+91' || phone
       WHERE phone ~ '^[6-9][0-9]{9}$'
    `);
    console.log(`  ✓ ${rowCount} existing leads prefixed with +91`);

    // 3. Add new columns (IF NOT EXISTS = safe to re-run)
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS city             VARCHAR(100),
        ADD COLUMN IF NOT EXISTS requirement_note TEXT,
        ADD COLUMN IF NOT EXISTS channel          VARCHAR(10)
    `);
    console.log('  ✓ city, requirement_note, channel columns added');

    // 4. Index channel for analytics queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel)
    `);
    console.log('  ✓ index on channel');

    console.log('\nMigration complete. No data was lost.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

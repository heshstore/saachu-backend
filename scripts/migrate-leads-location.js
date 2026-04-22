/* eslint-disable no-console */
/**
 * migrate-leads-location.js
 * Adds: state, country columns to leads table.
 * Safe to re-run (IF NOT EXISTS).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    console.log('Running leads location migration...\n');

    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS state   VARCHAR(100),
        ADD COLUMN IF NOT EXISTS country VARCHAR(100)
    `);
    console.log('  ✓ state, country columns added');

    // Back-fill source for any legacy rows that somehow ended up NULL
    // (source is a required field in the app, but guard against older imports).
    const { rowCount } = await client.query(`
      UPDATE leads SET source = 'DIRECT' WHERE source IS NULL
    `);
    if (rowCount > 0) console.log(`  ✓ back-filled source on ${rowCount} row(s)`);

    console.log('\nMigration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

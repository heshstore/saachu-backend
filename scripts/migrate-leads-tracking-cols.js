/* eslint-disable no-console */
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
    console.log('Adding tracking columns to leads table...');

    // ADD COLUMN IF NOT EXISTS is safe — no-ops if column already exists
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS lead_source_label VARCHAR(50),
        ADD COLUMN IF NOT EXISTS landing_page      TEXT
    `);
    console.log('  ✓ lead_source_label, landing_page added');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_source_label ON leads(lead_source_label)
    `);
    console.log('  ✓ index on lead_source_label');

    console.log('\nMigration complete. No data was lost.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

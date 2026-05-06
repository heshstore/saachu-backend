/* eslint-disable no-console */
/**
 * Lead Stage Migration
 * Adds the `stage` column to the leads table.
 * Idempotent — safe to run multiple times.
 *
 * Run: npm run migrate:lead-stage
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS stage VARCHAR(20) NOT NULL DEFAULT 'NEW'
    `);
    console.log('[1/2] leads.stage column — done');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage)
    `);
    console.log('[2/2] idx_leads_stage index — done');

    console.log('\n✅ Migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

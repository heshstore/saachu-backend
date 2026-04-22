/* eslint-disable no-console */
/**
 * WhatsApp Alerts Migration
 * Makes lead_alerts.lead_id nullable so system-level alerts (WHATSAPP_DOWN)
 * can be stored without a lead reference.
 *
 * Idempotent — safe to run multiple times.
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
    // DROP NOT NULL is idempotent in PostgreSQL — no error if already nullable
    await client.query(`
      ALTER TABLE lead_alerts
        ALTER COLUMN lead_id DROP NOT NULL
    `);
    console.log('[1/1] lead_alerts.lead_id — made nullable for system alerts');
    console.log('\nMigration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

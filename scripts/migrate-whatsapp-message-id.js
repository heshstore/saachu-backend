/* eslint-disable no-console */
/**
 * WhatsApp Message ID Migration
 *
 * Adds the whatsappMessageId column to the leads table and creates a
 * partial unique index to prevent duplicate leads from WhatsApp event storms:
 *
 *   leads."whatsappMessageId"
 *     TEXT, nullable.  Populated only for inbound WhatsApp leads.
 *
 *   idx_whatsapp_msg_id
 *     Partial UNIQUE index — only indexes rows where "whatsappMessageId" IS NOT NULL.
 *     Guarantees one lead per WhatsApp message ID; NULL rows (non-WhatsApp leads) are excluded.
 *
 * Idempotent — safe to run multiple times.
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

  try {
    // 1. Add column
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS "whatsappMessageId" TEXT;
    `);
    console.log('✓ Column "whatsappMessageId" ensured');

    // 2. Partial unique index — prevents duplicate leads from the same WA message
    //    CONCURRENTLY avoids a full table lock on live data.
    //    Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
    await client.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_msg_id
        ON leads("whatsappMessageId")
        WHERE "whatsappMessageId" IS NOT NULL;
    `);
    console.log('✓ Unique index idx_whatsapp_msg_id ensured');

    console.log('\nMigration complete.');
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

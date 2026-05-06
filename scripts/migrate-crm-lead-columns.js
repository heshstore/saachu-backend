/* eslint-disable no-console */
/**
 * CRM Lead Columns Migration
 *
 * Adds columns and indexes required for:
 *   - WhatsApp message-level dedup (whatsappMessageId + unique index)
 *   - Source reliability analytics (hasSerializedId)
 *   - Multi-touch attribution (contextHistory)
 *
 * Idempotent — safe to re-run.
 * CONCURRENTLY indexes avoid table locks on live data.
 * Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
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

  // 1. whatsappMessageId
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS "whatsappMessageId" VARCHAR(255);
  `);
  console.log('✓ Column "whatsappMessageId" ensured');

  // 2. Unique partial index for WhatsApp dedup
  //    CONCURRENTLY must run outside a transaction block.
  await client.query(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_whatsapp_msgid
      ON leads("whatsappMessageId")
      WHERE "whatsappMessageId" IS NOT NULL;
  `);
  console.log('✓ Unique index idx_leads_whatsapp_msgid ensured');

  // 3. hasSerializedId
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS "hasSerializedId" BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column "hasSerializedId" ensured');

  // 4. contextHistory
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS "contextHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  `);
  console.log('✓ Column "contextHistory" ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Promotion Contacts Migration
 * Creates the promotion_contacts table for exit popup / newsletter / discount captures.
 * Idempotent — safe to run multiple times.
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
      CREATE TABLE IF NOT EXISTS promotion_contacts (
        id               SERIAL PRIMARY KEY,
        whatsapp_number  VARCHAR(15),
        email            VARCHAR(255),
        source           TEXT NOT NULL,
        page_url         TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('✅ promotion_contacts table ready');

    // Unique index on whatsapp_number (partial — only non-null)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_whatsapp
        ON promotion_contacts(whatsapp_number)
        WHERE whatsapp_number IS NOT NULL AND whatsapp_number <> ''
    `);
    console.log('✅ idx_promo_whatsapp index ready');

    // Unique index on email (partial — only non-null)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_email
        ON promotion_contacts(email)
        WHERE email IS NOT NULL AND email <> ''
    `);
    console.log('✅ idx_promo_email index ready');

    // Verify
    const { rows } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'promotion_contacts'
      ORDER BY ordinal_position
    `);
    console.log('Columns:', rows.map(r => r.column_name).join(', '));

  } finally {
    await client.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });

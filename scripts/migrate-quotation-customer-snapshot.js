/* eslint-disable no-console */
/**
 * Adds customer snapshot columns to the quotation table:
 *   customer_phone   VARCHAR(30)   NULL
 *   billing_address  TEXT          NULL
 *   shipping_address TEXT          NULL
 *   gst_number       VARCHAR(20)   NULL
 *
 * Backfills existing rows from the customer table.
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

  // 1. Add columns
  await client.query(`ALTER TABLE quotation ADD COLUMN IF NOT EXISTS customer_phone   VARCHAR(30)  NULL`);
  console.log('✓ Column customer_phone ensured');

  await client.query(`ALTER TABLE quotation ADD COLUMN IF NOT EXISTS billing_address  TEXT         NULL`);
  console.log('✓ Column billing_address ensured');

  await client.query(`ALTER TABLE quotation ADD COLUMN IF NOT EXISTS shipping_address TEXT         NULL`);
  console.log('✓ Column shipping_address ensured');

  await client.query(`ALTER TABLE quotation ADD COLUMN IF NOT EXISTS gst_number       VARCHAR(20)  NULL`);
  console.log('✓ Column gst_number ensured');

  // 2. Backfill from customer table for existing rows
  const { rowCount } = await client.query(`
    UPDATE quotation q
    SET
      customer_name    = COALESCE(q.customer_name,    c."companyName", c."contactName", ''),
      customer_phone   = COALESCE(q.customer_phone,   c."mobile1",     ''),
      billing_address  = COALESCE(q.billing_address,
        NULLIF(TRIM(CONCAT_WS(', ', c.address, c.city, c.state, c.pincode)), '')),
      shipping_address = COALESCE(q.shipping_address,
        NULLIF(TRIM(CONCAT_WS(', ', c.address, c.city, c.state, c.pincode)), '')),
      gst_number       = COALESCE(q.gst_number,       c."gstNumber",   '')
    FROM customer c
    WHERE q.customer_id = c.id
      AND (
        q.customer_phone   IS NULL OR
        q.billing_address  IS NULL OR
        q.shipping_address IS NULL OR
        q.gst_number       IS NULL
      )
  `);
  console.log(`✓ Backfilled ${rowCount} existing quotation rows from customer table`);

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

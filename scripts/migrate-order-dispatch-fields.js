/* eslint-disable no-console */
/**
 * Adds dispatch/delivery fields to the orders table.
 * Idempotent — safe to run multiple times.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  return url && url.includes('neon.tech') ? { rejectUnauthorized: false } : false;
}

async function run() {
  const url = process.env.DATABASE_URL;
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  const cols = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS booking_at VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS goods_sent_by VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_payment_by VARCHAR(255)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_instructions TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(255)`,
  ];

  for (const sql of cols) {
    await client.query(sql);
    console.log('OK:', sql.split('ADD COLUMN IF NOT EXISTS')[1]?.trim().split(' ')[0]);
  }

  await client.end();
  console.log('Migration complete.');
}

run().catch((e) => { console.error(e); process.exit(1); });

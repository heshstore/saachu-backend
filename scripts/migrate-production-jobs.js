/* eslint-disable no-console */
/**
 * Creates the production_jobs table.
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS production_jobs (
      id            SERIAL PRIMARY KEY,
      order_id      INT          NOT NULL,
      order_item_id INT          NOT NULL,
      sku           VARCHAR(100),
      item_name     VARCHAR(500),
      qty           NUMERIC(10,2) NOT NULL DEFAULT 1,
      status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);
  console.log('✓ Table production_jobs ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_production_order ON production_jobs(order_id)
  `);
  console.log('✓ Index idx_production_order ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

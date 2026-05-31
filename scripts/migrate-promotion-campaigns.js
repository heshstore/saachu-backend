/**
 * migrate-promotion-campaigns.js
 *
 * Adds is_promotion and test_mode boolean columns to marketing_campaigns.
 * Idempotent — safe to re-run: uses ADD COLUMN IF NOT EXISTS.
 *
 * Run: npm run migrate:promotion-campaigns
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  try {
    await client.query('BEGIN');

    // is_promotion: marks campaign as a fixed-rule promotion (window/delay/audience locked)
    await client.query(`
      ALTER TABLE marketing_campaigns
      ADD COLUMN IF NOT EXISTS is_promotion BOOLEAN NOT NULL DEFAULT false
    `);
    console.log('✓ marketing_campaigns.is_promotion');

    // test_mode: when true, sends only to the 6 hardcoded test phones
    await client.query(`
      ALTER TABLE marketing_campaigns
      ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false
    `);
    console.log('✓ marketing_campaigns.test_mode');

    await client.query('COMMIT');
    console.log('✅ migrate-promotion-campaigns complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });

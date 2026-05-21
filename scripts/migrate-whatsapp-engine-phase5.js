/**
 * Phase 5 migration — WhatsApp Marketing Engine
 * Adds is_test_contact boolean to marketing_audience.
 * Idempotent — safe to re-run.
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  try {
    await client.query('BEGIN');

    // Add is_test_contact to marketing_audience
    await client.query(`
      ALTER TABLE marketing_audience
        ADD COLUMN IF NOT EXISTS is_test_contact BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ma_test_contact
        ON marketing_audience (is_test_contact)
        WHERE is_test_contact = TRUE
    `);
    console.log('✓ marketing_audience.is_test_contact');

    await client.query('COMMIT');
    console.log('\n✅ Phase 5 migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

/**
 * Phase 7 migration — WhatsApp Marketing Engine behavioral calibration.
 * Adds:
 *   marketing_audience.cooldown_until   — smart contact cooldown
 *   marketing_templates.performance_weight — weighted template selection
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

    // Add cooldown_until to marketing_audience
    await client.query(`
      ALTER TABLE marketing_audience
        ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ma_cooldown_until
        ON marketing_audience (cooldown_until)
        WHERE cooldown_until IS NOT NULL
    `);
    console.log('✓ marketing_audience.cooldown_until');

    // Add performance_weight to marketing_templates
    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS performance_weight DECIMAL(5,2) NOT NULL DEFAULT 1.0
    `);
    console.log('✓ marketing_templates.performance_weight');

    await client.query('COMMIT');
    console.log('\n✅ Phase 7 migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

/**
 * Phase 9 migration — WhatsApp Engine controlled expansion.
 * Adds:
 *   marketing_audience.fatigue_score     — per-contact fatigue (ignores/no-reads/no-replies)
 *   marketing_templates.product_category — enables product rotation balancer
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

    // fatigue_score on marketing_audience
    await client.query(`
      ALTER TABLE marketing_audience
        ADD COLUMN IF NOT EXISTS fatigue_score DECIMAL(5,2) NOT NULL DEFAULT 0
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ma_fatigue_score
        ON marketing_audience (fatigue_score)
        WHERE fatigue_score > 0
    `);
    console.log('✓ marketing_audience.fatigue_score');

    // product_category on marketing_templates
    await client.query(`
      ALTER TABLE marketing_templates
        ADD COLUMN IF NOT EXISTS product_category VARCHAR(100)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mt_product_category
        ON marketing_templates (product_category)
        WHERE product_category IS NOT NULL
    `);
    console.log('✓ marketing_templates.product_category');

    await client.query('COMMIT');
    console.log('\n✅ Phase 9 migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

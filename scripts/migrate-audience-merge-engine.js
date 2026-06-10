/**
 * Promotional DB — Master Contact Merge Engine columns + filter indexes.
 * Safe to run multiple times (IF NOT EXISTS).
 *
 * Usage: node scripts/migrate-audience-merge-engine.js
 */
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const url = (process.env.DATABASE_URL || '').replace(/channel_binding=require&?/, '');
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const stmts = [
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS sources_used JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS source_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS contact_strength VARCHAR(10) NOT NULL DEFAULT 'LOW'`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS duplicate_status VARCHAR(30)`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS duplicate_email_phone VARCHAR(30)`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS merge_suggestion JSONB`,
    // Backfill source history from legacy single source column
    `UPDATE marketing_audience
     SET sources_used = jsonb_build_array(source),
         source_count = 1
     WHERE source IS NOT NULL AND source != ''
       AND (sources_used IS NULL OR sources_used = '[]'::jsonb)`,
    `UPDATE marketing_audience
     SET contact_strength = CASE
       WHEN phone IS NOT NULL AND COALESCE(name, customer_name) IS NOT NULL
         AND email IS NOT NULL AND city IS NOT NULL AND business_type IS NOT NULL THEN 'HIGH'
       WHEN phone IS NOT NULL AND COALESCE(name, customer_name) IS NOT NULL AND city IS NOT NULL THEN 'MEDIUM'
       ELSE 'LOW'
     END
     WHERE contact_strength = 'LOW'`,
    `CREATE INDEX IF NOT EXISTS idx_ma_city ON marketing_audience(city) WHERE city IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_state ON marketing_audience(state) WHERE state IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_country ON marketing_audience(country) WHERE country IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_business_type ON marketing_audience(business_type) WHERE business_type IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_contact_strength ON marketing_audience(contact_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_ma_email_lower ON marketing_audience(LOWER(email)) WHERE email IS NOT NULL AND email != ''`,
    `CREATE INDEX IF NOT EXISTS idx_ma_last_enriched ON marketing_audience(last_enriched_at) WHERE last_enriched_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_duplicate_status ON marketing_audience(duplicate_status) WHERE duplicate_status IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_ma_source_count ON marketing_audience(source_count)`,
  ];

  for (const sql of stmts) {
    await client.query(sql);
    console.log('✓', sql.slice(0, 80).replace(/\s+/g, ' '));
  }

  await client.end();
  console.log('\n✅ marketing_audience merge-engine migration complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

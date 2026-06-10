#!/usr/bin/env node
/**
 * DB-MIG-2026-06-12-GEO-QUALITY
 * Promotional DB geo quality columns — safe to run multiple times.
 */
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const url = (process.env.DATABASE_URL || '').replace(/channel_binding=require&?/, '');
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const stmts = [
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS geo_quality VARCHAR(10) NOT NULL DEFAULT 'PARTIAL'`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS geo_source VARCHAR(20)`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS geo_resolved_at TIMESTAMPTZ`,
    `ALTER TABLE marketing_audience ADD COLUMN IF NOT EXISTS geo_corrections JSONB NOT NULL DEFAULT '[]'`,
    `CREATE INDEX IF NOT EXISTS idx_ma_geo_quality ON marketing_audience(geo_quality)`,
    `CREATE INDEX IF NOT EXISTS idx_ma_geo_source ON marketing_audience(geo_source) WHERE geo_source IS NOT NULL`,
    // Existing rows without city → PARTIAL (phone-only leads preserved).
    `UPDATE marketing_audience SET geo_quality = 'PARTIAL'
     WHERE geo_quality IS NULL OR geo_quality = ''
       OR (NULLIF(TRIM(city), '') IS NULL)`,
    `UPDATE marketing_audience SET geo_quality = 'VALID'
     WHERE NULLIF(TRIM(city), '') IS NOT NULL
       AND NULLIF(TRIM(state), '') IS NOT NULL
       AND NULLIF(TRIM(country), '') IS NOT NULL`,
  ];

  for (const sql of stmts) {
    await client.query(sql);
    console.log('OK:', sql.slice(0, 80));
  }

  await client.end();
  console.log('✅ Geo quality migration complete');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

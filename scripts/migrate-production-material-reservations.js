/**
 * Production material reservations + optional stage wastage note column.
 * Run: node scripts/migrate-production-material-reservations.js
 */
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is missing');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_material_reservations (
        id SERIAL PRIMARY KEY,
        production_job_id INT NOT NULL REFERENCES production_execution_jobs(id) ON DELETE CASCADE,
        production_stage_id INT REFERENCES production_job_stages(id) ON DELETE SET NULL,
        raw_material_item_id INT NOT NULL,
        required_qty DOUBLE PRECISION NOT NULL,
        reserved_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        consumed_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        warehouse_id INT NOT NULL REFERENCES warehouses(id),
        status VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
        remarks TEXT,
        planned_rate DOUBLE PRECISION,
        actual_rate DOUBLE PRECISION,
        consumed_value DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_prod_mat_res_job ON production_material_reservations (production_job_id);
      CREATE INDEX IF NOT EXISTS idx_prod_mat_res_job_raw ON production_material_reservations (production_job_id, raw_material_item_id);
    `);
    await client.query(`
      ALTER TABLE production_material_reservations DROP CONSTRAINT IF EXISTS uq_prod_mat_res_job_raw;
    `);
    await client.query(`
      ALTER TABLE production_job_stages
        ADD COLUMN IF NOT EXISTS wastage_remarks TEXT;
    `);
    console.log('✓ production_material_reservations + wastage_remarks ensured');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

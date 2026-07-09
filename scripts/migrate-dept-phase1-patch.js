'use strict';
/**
 * Migration: Department Phase 1 patch
 * Adds `operator` and `ready_date` columns to department_machines.
 * Updates status CHECK constraint to include READY.
 * Run: npm run migrate:dept-phase1-patch
 */
require('dotenv').config();
const { Client } = require('pg');

const url = process.env.DATABASE_URL || process.env.LOCAL_DATABASE_URL;
if (!url) { console.error('No DATABASE_URL'); process.exit(1); }

async function run() {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE department_machines ADD COLUMN IF NOT EXISTS operator VARCHAR(100)`);
    await client.query(`ALTER TABLE department_machines ADD COLUMN IF NOT EXISTS ready_date DATE`);

    // Expand status to include READY — drop old constraint first (IF EXISTS), add new one
    await client.query(`ALTER TABLE department_machines DROP CONSTRAINT IF EXISTS department_machines_status_check`);
    await client.query(`
      ALTER TABLE department_machines
      ADD CONSTRAINT department_machines_status_check
      CHECK (status IN ('READY','RUNNING','IDLE','BREAKDOWN','MAINTENANCE'))
    `);

    await client.query('COMMIT');
    console.log('✓ Phase 1 patch complete — operator, ready_date columns added; READY status enabled');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

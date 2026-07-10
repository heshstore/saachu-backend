/**
 * migrate-machine-inspection-patch.js
 *
 * Separates operational status from inspection readiness on department_machines.
 *
 * Changes:
 *  1. Drop old status check constraint (which included READY / NOT_READY)
 *  2. Re-add constraint with only operational values: IDLE, RUNNING, BREAKDOWN, MAINTENANCE
 *  3. Convert any legacy READY / NOT_READY rows to IDLE
 *  4. Add last_inspected_at TIMESTAMPTZ NULL
 *  5. Add last_inspected_by INT NULL
 */

require('dotenv/config');
const { Client } = require('pg');

async function run() {
  const url = process.env.DATABASE_URL || process.env.LOCAL_DATABASE_URL;
  if (!url) throw new Error('No DATABASE_URL or LOCAL_DATABASE_URL set');

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query('BEGIN');

    // 1. Drop old check constraint (name from previous migration)
    await client.query(`
      ALTER TABLE department_machines
        DROP CONSTRAINT IF EXISTS department_machines_status_check
    `);

    // 2. Migrate legacy status values to IDLE before adding the new constraint
    await client.query(`
      UPDATE department_machines
         SET status = 'IDLE'
       WHERE status IN ('READY', 'NOT_READY')
    `);

    // 3. Add new constraint — operational states only, no inspection states
    await client.query(`
      ALTER TABLE department_machines
        ADD CONSTRAINT department_machines_status_check
        CHECK (status IN ('IDLE','RUNNING','BREAKDOWN','MAINTENANCE'))
    `);

    // 4. Add inspection cache columns
    await client.query(`
      ALTER TABLE department_machines
        ADD COLUMN IF NOT EXISTS last_inspected_at  TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS last_inspected_by  INT         NULL
    `);

    await client.query('COMMIT');
    console.log('✓ Machine inspection patch complete');
    console.log('  — status enum: IDLE | RUNNING | BREAKDOWN | MAINTENANCE');
    console.log('  — last_inspected_at / last_inspected_by columns added');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });

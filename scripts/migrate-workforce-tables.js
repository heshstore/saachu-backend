/* eslint-disable no-console */
/**
 * Workforce module schema — initial table creation.
 *
 * Creates 4 tables (in dependency order) that workforce-ops.service.ts requires.
 * Idempotent — safe to run multiple times.
 *
 * Run (local):  node scripts/migrate-workforce-tables.js
 * Run (prod):   NODE_ENV=production node scripts/migrate-workforce-tables.js
 */
const { resolveScriptDb } = require('./lib/script-db');
const { url: DB_URL, ssl: DB_SSL } = resolveScriptDb();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: DB_SSL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ── 1. shift_master ────────────────────────────────────────────────────────
    // No FKs — must be created before employee_workforce_profiles.
    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_master (
        id             SERIAL PRIMARY KEY,
        shift_name     TEXT        NOT NULL,
        start_time     TIME        NOT NULL,
        end_time       TIME        NOT NULL,
        break_minutes  INT         NOT NULL DEFAULT 0,
        active         BOOLEAN     NOT NULL DEFAULT true,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('✅ shift_master');

    // ── 2. employee_workforce_profiles ────────────────────────────────────────
    // FKs: "user"(id), departments(id), shift_master(id) — all exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_workforce_profiles (
        id                   SERIAL PRIMARY KEY,
        user_id              INT         NOT NULL REFERENCES "user"(id),
        employee_code        TEXT        NOT NULL,
        department_id        INT         REFERENCES departments(id),
        designation          TEXT,
        joining_date         DATE,
        shift_master_id      INT         REFERENCES shift_master(id),
        shift_type           TEXT,
        daily_working_hours  NUMERIC     NOT NULL DEFAULT 8,
        overtime_eligible    BOOLEAN     NOT NULL DEFAULT true,
        active               BOOLEAN     NOT NULL DEFAULT true,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_workforce_profile_user UNIQUE (user_id)
      )
    `);
    console.log('✅ employee_workforce_profiles');

    // ── 3. attendance_records ─────────────────────────────────────────────────
    // ON CONFLICT (user_id, attendance_date) in service — UNIQUE constraint required.
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id               SERIAL PRIMARY KEY,
        user_id          INT         NOT NULL REFERENCES "user"(id),
        attendance_date  DATE        NOT NULL,
        check_in_time    TIMESTAMPTZ,
        check_out_time   TIMESTAMPTZ,
        total_hours      NUMERIC,
        overtime_hours   NUMERIC,
        status           TEXT        NOT NULL
                           CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','LEAVE','HOLIDAY')),
        remarks          TEXT,
        CONSTRAINT uq_attendance_user_date UNIQUE (user_id, attendance_date)
      )
    `);
    console.log('✅ attendance_records');

    // ── 4. leave_requests ─────────────────────────────────────────────────────
    // approved_by is nullable FK (leave can be pending / unapproved).
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id          SERIAL PRIMARY KEY,
        user_id     INT         NOT NULL REFERENCES "user"(id),
        leave_type  TEXT        NOT NULL
                      CHECK (leave_type IN ('CASUAL','SICK','EMERGENCY','UNPAID')),
        from_date   DATE        NOT NULL,
        to_date     DATE        NOT NULL,
        reason      TEXT,
        status      TEXT        NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
        approved_by INT         REFERENCES "user"(id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('✅ leave_requests');

    await client.query('COMMIT');
    console.log('\nTables committed.\n');

    // ── Indexes (outside transaction — CREATE INDEX IF NOT EXISTS is safe) ─────

    // employee_workforce_profiles
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ewp_department_id
        ON employee_workforce_profiles (department_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ewp_active
        ON employee_workforce_profiles (active)
    `);
    console.log('✅ employee_workforce_profiles indexes');

    // attendance_records — attendance_date and (user_id, attendance_date) are
    // the dominant filter patterns in getDashboard, getAvailability, getProductivity.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_date
        ON attendance_records (attendance_date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_user_date
        ON attendance_records (user_id, attendance_date)
    `);
    console.log('✅ attendance_records indexes');

    // leave_requests — listLeaves filters on (user_id, status); getDashboard counts by status.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leave_user_status
        ON leave_requests (user_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leave_status
        ON leave_requests (status)
    `);
    console.log('✅ leave_requests indexes');

    // ── Verify ────────────────────────────────────────────────────────────────
    const { rows: tables } = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('shift_master','employee_workforce_profiles',
                           'attendance_records','leave_requests')
      ORDER BY table_name
    `);
    console.log(`\nVerification — tables present (${tables.length}/4):`);
    tables.forEach((r) => console.log(`  ✓ ${r.table_name}`));

    const { rows: indexes } = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename IN ('employee_workforce_profiles','attendance_records','leave_requests')
        AND indexname LIKE 'idx_%'
      ORDER BY indexname
    `);
    console.log(`\nVerification — indexes present (${indexes.length}):`);
    indexes.forEach((r) => console.log(`  ✓ ${r.indexname}`));

    if (tables.length !== 4) {
      console.error('\n❌ Expected 4 tables — something went wrong.');
      process.exit(1);
    }

    console.log('\n✅ Workforce schema migration complete.\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

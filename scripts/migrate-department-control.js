'use strict';
/**
 * Migration: Department Control Center
 * Adds 11 new tables alongside the existing `departments` table.
 * The existing table is NOT modified.
 * Run: npm run migrate:dept-control
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

    // ── 1. Extension (extra fields, 1:1 with departments) ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_extensions (
        id                          SERIAL PRIMARY KEY,
        department_id               INT NOT NULL UNIQUE REFERENCES departments(id) ON DELETE CASCADE,
        description                 TEXT,
        dept_type                   VARCHAR(50) DEFAULT 'Production',
        working_hours_per_day       NUMERIC(4,1) DEFAULT 8,
        no_machines                 INT DEFAULT 0,
        no_operators                INT DEFAULT 0,
        efficiency_pct              NUMERIC(5,2) DEFAULT 85,
        oee_target_pct              NUMERIC(5,2) DEFAULT 80,
        manager_name                VARCHAR(100),
        supervisor_name             VARCHAR(100),
        team_leader_name            VARCHAR(100),
        require_qc                  BOOLEAN DEFAULT FALSE,
        inspection_type             VARCHAR(50),
        allow_parallel_jobs         BOOLEAN DEFAULT TRUE,
        require_supervisor_approval BOOLEAN DEFAULT FALSE,
        require_qc_rule             BOOLEAN DEFAULT FALSE,
        allow_skip_process          BOOLEAN DEFAULT FALSE,
        allow_overtime              BOOLEAN DEFAULT FALSE,
        created_at                  TIMESTAMPTZ DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 2. Checklists (one per department) ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_checklists (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL UNIQUE REFERENCES departments(id) ON DELETE CASCADE,
        name          VARCHAR(200) DEFAULT 'Daily Machine Startup Checklist',
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 3. Checklist items ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_checklist_items (
        id            SERIAL PRIMARY KEY,
        checklist_id  INT NOT NULL REFERENCES department_checklists(id) ON DELETE CASCADE,
        item_text     VARCHAR(300) NOT NULL,
        is_mandatory  BOOLEAN DEFAULT TRUE,
        is_active     BOOLEAN DEFAULT TRUE,
        sort_order    INT DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 4. Daily checklist sessions ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_checklist_sessions (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        session_date  DATE NOT NULL DEFAULT CURRENT_DATE,
        started_by    INT,
        started_at    TIMESTAMPTZ DEFAULT NOW(),
        is_complete   BOOLEAN DEFAULT FALSE,
        approved_by   INT,
        approved_at   TIMESTAMPTZ,
        UNIQUE(department_id, session_date)
      )
    `);

    // ── 5. Checklist completions (which items ticked per session) ───────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_checklist_completions (
        id           SERIAL PRIMARY KEY,
        session_id   INT NOT NULL REFERENCES department_checklist_sessions(id) ON DELETE CASCADE,
        item_id      INT NOT NULL REFERENCES department_checklist_items(id) ON DELETE CASCADE,
        completed_by INT,
        completed_at TIMESTAMPTZ DEFAULT NOW(),
        notes        TEXT,
        UNIQUE(session_id, item_id)
      )
    `);

    // ── 6. Machines ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_machines (
        id                SERIAL PRIMARY KEY,
        department_id     INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        machine_ref_id    VARCHAR(50),
        name              VARCHAR(200) NOT NULL,
        machine_type      VARCHAR(100),
        model             VARCHAR(100),
        serial_number     VARCHAR(100),
        installation_date DATE,
        capacity          NUMERIC(10,2),
        capacity_unit     VARCHAR(50),
        status            VARCHAR(20) DEFAULT 'IDLE'
                            CHECK (status IN ('RUNNING','IDLE','BREAKDOWN','MAINTENANCE')),
        is_active         BOOLEAN DEFAULT TRUE,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 7. Preventive maintenance schedules ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_maintenance_schedules (
        id                  SERIAL PRIMARY KEY,
        department_id       INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        frequency           VARCHAR(20) NOT NULL DEFAULT 'DAILY'
                              CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
        task_name           VARCHAR(300) NOT NULL,
        estimated_minutes   INT DEFAULT 30,
        responsible_person  VARCHAR(100),
        last_completed_at   TIMESTAMPTZ,
        last_completed_by   INT,
        notes               TEXT,
        is_active           BOOLEAN DEFAULT TRUE,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 8. Skills ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_skills (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        skill_name    VARCHAR(200) NOT NULL,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 9. KPIs ─────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_kpis (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        kpi_name      VARCHAR(200) NOT NULL,
        target_value  NUMERIC(10,2),
        unit          VARCHAR(50),
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 10. KRAs ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_kras (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        kra_name      VARCHAR(200) NOT NULL,
        description   TEXT,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 11. Documents ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS department_documents (
        id            SERIAL PRIMARY KEY,
        department_id INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        doc_type      VARCHAR(50) DEFAULT 'SOP'
                        CHECK (doc_type IN ('SOP','MACHINE_MANUAL','MAINTENANCE_MANUAL','SAFETY_MANUAL','WORK_INSTRUCTION')),
        doc_name      VARCHAR(300) NOT NULL,
        file_url      TEXT,
        uploaded_by   INT,
        uploaded_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Indexes ─────────────────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dept_checklist_items_checklist ON department_checklist_items(checklist_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dept_sessions_dept_date ON department_checklist_sessions(department_id, session_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dept_completions_session ON department_checklist_completions(session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dept_machines_dept ON department_machines(department_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dept_maintenance_dept ON department_maintenance_schedules(department_id)`);

    await client.query('COMMIT');
    console.log('✓ Department Control Center migration complete — 11 tables created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

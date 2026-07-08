'use strict';
/**
 * Migration: production_board_tasks
 * Central production coordination table.
 * Each row = one department assignment for one order item.
 * Run: npm run migrate:production-board
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS production_board_tasks (
        id               SERIAL PRIMARY KEY,

        -- Order context
        order_id         INT NOT NULL,
        order_item_id    INT NOT NULL,

        -- Item snapshot (denormalized for display speed)
        item_name        VARCHAR(255),
        sku              VARCHAR(100),
        qty              DECIMAL(10,2) DEFAULT 1,
        unit             VARCHAR(50),
        item_type        VARCHAR(30)  DEFAULT 'OTHER',  -- MANUFACTURING | TRADING | OTHER
        customer_name    VARCHAR(255),
        order_no         VARCHAR(50),
        due_date         DATE,

        -- Assignment
        department_id    INT,
        department_name  VARCHAR(255),

        -- Status
        status           VARCHAR(30)  NOT NULL DEFAULT 'WAITING',
        -- WAITING | ASSIGNED | IN_PROGRESS | COMPLETED | ON_HOLD | CANCELLED | BLOCKED

        -- Lifecycle stage
        stage            VARCHAR(30)  NOT NULL DEFAULT 'DEPARTMENT',
        -- DEPARTMENT | PACKING | BILLING | DONE

        -- Sequence within this item's history (1 = first assignment, 2 = second, …)
        task_no          INT NOT NULL DEFAULT 1,

        -- Parallel dependency: array of production_board_tasks.id that must be COMPLETED first
        depends_on       INT[] DEFAULT '{}',

        -- Priority
        priority         VARCHAR(20) DEFAULT 'MEDIUM',

        -- Audit
        created_by       INT,
        assigned_by      INT,
        started_by       INT,
        completed_by     INT,

        assigned_at      TIMESTAMPTZ,
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ,
        held_at          TIMESTAMPTZ,

        remarks          TEXT,

        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pbt_order        ON production_board_tasks(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pbt_order_item   ON production_board_tasks(order_item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pbt_department   ON production_board_tasks(department_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pbt_status       ON production_board_tasks(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pbt_stage        ON production_board_tasks(stage)`);

    await client.query('COMMIT');
    console.log('✅  production_board_tasks created');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

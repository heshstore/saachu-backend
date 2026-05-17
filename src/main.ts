import * as dotenv from 'dotenv';
dotenv.config();
import * as net from 'net';
import { Client } from 'pg';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { LoggingInterceptor } from './common/logging.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { sanitizeDatabaseUrl, buildSslOption, redactDatabaseUrl } from './utils/db-url.util';

const logger = new Logger('Bootstrap');

/**
 * TCP probe — resolves true if something is already listening on the port.
 * Used in dev mode to detect duplicate startups before heavy initialization.
 */
function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket
      .once('connect', () => { socket.destroy(); resolve(true); })
      .once('timeout',  () => { socket.destroy(); resolve(false); })
      .once('error',    () => { socket.destroy(); resolve(false); })
      .connect(port, '127.0.0.1');
  });
}

/** Short pause — lets the previous process fully release the port after nodemon SIGTERM. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Creates and connects a one-shot pg Client using DATABASE_URL (channel_binding stripped). */
async function createMigrationClient(): Promise<Client> {
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) throw new Error('DATABASE_URL is not set');
  const url = sanitizeDatabaseUrl(raw);
  const ssl  = buildSslOption(url);
  const client = new Client({ connectionString: url, ssl: ssl === false ? undefined : ssl });
  await client.connect();
  return client;
}

/**
 * Attempts app.listen() on each candidate port.
 *
 * Production: scans up to 16 ports (Render assigns arbitrary ports).
 * Development: exits immediately if the preferred port is occupied.
 *   Rationale: multiple dev instances each spawn a WhatsApp/Puppeteer
 *   initializer against the same session directory, causing SingletonLock
 *   races and EPERM errors on Chrome process cleanup.
 */
async function listenWithFallback(app: any, preferred: number): Promise<number> {
  const isDev    = (process.env.NODE_ENV ?? 'development') !== 'production';
  const maxTries = isDev ? 1 : 16;

  for (let i = 0; i < maxTries; i++) {
    const candidate = preferred + i;
    try {
      await app.listen(candidate);
      return candidate;
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') {
        if (isDev) {
          logger.warn(
            `[Bootstrap] Duplicate backend instance detected — port ${preferred} already in use.\n` +
            `  Backend already running on port ${preferred}. Skipping duplicate startup.\n` +
            `  (Multiple dev instances each launch a WhatsApp/Chromium process against the same\n` +
            `  session directory, causing SingletonLock races and EPERM errors.)\n` +
            `  To restart cleanly: lsof -ti :${preferred} | xargs kill -9`,
          );
          process.exit(0);  // exit(0) — not a crash, just a duplicate startup
        }
        logger.warn(`[Bootstrap] Port ${candidate} occupied — trying ${candidate + 1}…`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `[Bootstrap] No free port found in range ${preferred}–${preferred + 15}. ` +
    `Kill stale processes: lsof -ti :${preferred} | xargs kill -9`,
  );
}

async function ensurePromotionTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_contacts (
        id               SERIAL PRIMARY KEY,
        whatsapp_number  VARCHAR(15),
        email            VARCHAR(255),
        source           TEXT NOT NULL,
        page_url         TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_whatsapp
        ON promotion_contacts(whatsapp_number)
        WHERE whatsapp_number IS NOT NULL AND whatsapp_number <> ''
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_email
        ON promotion_contacts(email)
        WHERE email IS NOT NULL AND email <> ''
    `);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureAnalyticsTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id         SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        event      TEXT NOT NULL,
        product    TEXT,
        page_url   TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_event   ON analytics_events(event)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analytics_product ON analytics_events(product)`);
    console.log('📊 ANALYTICS TABLE READY');
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureWhatsappSessionColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      ALTER TABLE whatsapp_sessions
        ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ
    `);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureDispatchTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id               SERIAL PRIMARY KEY,
        order_id         INT NOT NULL,
        dispatch_status  VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        dispatch_date    TIMESTAMPTZ,
        delivery_date    TIMESTAMPTZ,
        transport_type   VARCHAR(20),
        tracking_number  VARCHAR,
        notes            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatches_order_id
        ON dispatches(order_id)
    `);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureNotificationColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    const cols = [
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category     VARCHAR(20)`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url   VARCHAR(500)`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS role_targets TEXT`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata     JSONB`,
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS hidden_at    TIMESTAMPTZ`,
    ];
    for (const sql of cols) {
      await client.query(sql).catch(() => {});
    }
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureActivityTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        module               VARCHAR(20)  NOT NULL,
        entity_type          VARCHAR(30),
        entity_id            INT,
        action               VARCHAR(50)  NOT NULL,
        title                VARCHAR(200) NOT NULL,
        description          TEXT,
        performed_by_user_id INT,
        performed_by_name    VARCHAR(100),
        performed_by_role    VARCHAR(50),
        source               VARCHAR(15)  NOT NULL DEFAULT 'SYSTEM',
        old_value            JSONB,
        new_value            JSONB,
        metadata             JSONB,
        ip_address           VARCHAR(50),
        user_agent           VARCHAR(300),
        severity             VARCHAR(8)   NOT NULL DEFAULT 'INFO',
        created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_act_module   ON activity_logs(module)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_act_entity   ON activity_logs(entity_type, entity_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_act_actor    ON activity_logs(performed_by_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_act_severity ON activity_logs(severity)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_act_created  ON activity_logs(created_at DESC)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureNewItemTables(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`CREATE SEQUENCE IF NOT EXISTS svc_item_code_seq START 1`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS shopify_catalog_items (
        id                 SERIAL PRIMARY KEY,
        item_code          VARCHAR UNIQUE NOT NULL,
        shopify_product_id VARCHAR,
        shopify_variant_id VARCHAR UNIQUE NOT NULL,
        item_name          VARCHAR,
        sku                VARCHAR UNIQUE,
        selling_price      DOUBLE PRECISION NOT NULL DEFAULT 0,
        retail_price       DOUBLE PRECISION NOT NULL DEFAULT 0,
        wholesale_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
        image              TEXT,
        unit               VARCHAR NOT NULL DEFAULT 'Nos',
        hsn_code           VARCHAR NOT NULL DEFAULT '',
        gst                DOUBLE PRECISION NOT NULL DEFAULT 0,
        cost_price         DOUBLE PRECISION NOT NULL DEFAULT 0,
        sync_ignored       BOOLEAN NOT NULL DEFAULT FALSE,
        source             VARCHAR NOT NULL DEFAULT 'SHOPIFY',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_items (
        id            SERIAL PRIMARY KEY,
        item_code     VARCHAR UNIQUE NOT NULL,
        item_name     VARCHAR,
        sku           VARCHAR UNIQUE,
        hsn_code      VARCHAR NOT NULL DEFAULT '',
        gst           DOUBLE PRECISION NOT NULL DEFAULT 0,
        cost_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
        selling_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        unit          VARCHAR NOT NULL DEFAULT 'Nos',
        source        VARCHAR NOT NULL DEFAULT 'MANUAL',
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureOrderColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    const cols = [
      // New columns
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS quotation_id  INTEGER`,
      // Approval data persistence — structured fields (not mixed into approval_remarks string)
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_amount           NUMERIC(10,2)`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS process_without_advance  BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason         TEXT`,
      // Legacy columns: mobile and order_number are NOT NULL in the original schema but are
      // not mapped by the TypeORM entity (app uses customer_phone / order_no instead).
      // TypeORM INSERTs don't include them, causing constraint violations.
      // Give them safe defaults so INSERTs succeed; the real phone goes into customer_phone.
      `ALTER TABLE orders ALTER COLUMN mobile       SET DEFAULT ''`,
      `ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT ''`,
      // Backfill: sync mobile from customer_phone for rows that have phone data
      `UPDATE orders SET mobile = customer_phone WHERE mobile = '' AND customer_phone IS NOT NULL AND customer_phone <> ''`,

      // order_item legacy columns: NOT NULL with no DEFAULT, not in TypeORM entity.
      // TypeORM INSERT only writes entity-mapped columns; these legacy columns get no value
      // and PostgreSQL rejects the INSERT. Set safe defaults so inserts succeed; a raw UPDATE
      // after save populates them with real data for any tooling that reads legacy columns.
      `ALTER TABLE order_item ALTER COLUMN "itemName"  SET DEFAULT ''`,
      `ALTER TABLE order_item ALTER COLUMN quantity    SET DEFAULT 0`,
      `ALTER TABLE order_item ALTER COLUMN msp_price   SET DEFAULT 0`,
      // Backfill existing rows: populate legacy columns from modern equivalents
      `UPDATE order_item SET "itemName" = COALESCE(NULLIF(item_name, ''), 'Item') WHERE "itemName" = ''`,
      `UPDATE order_item SET quantity   = qty::integer WHERE quantity = 0 AND qty IS NOT NULL`,
      `UPDATE order_item SET msp_price  = COALESCE(rate, 0)              WHERE msp_price = 0`,
    ];
    for (const sql of cols) {
      await client.query(sql).catch(() => {});
    }
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureQuotationColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(
      `ALTER TABLE quotation ADD COLUMN IF NOT EXISTS converted_order_id INTEGER`,
    ).catch(() => {});

    // Rename legacy status values — idempotent, safe to run on every boot.
    // SENT → GENERATED (old name before rename)
    // APPROVED → GENERATED (approval step removed; generated is the terminal pre-order state)
    // REJECTED → CANCELLED (rejection maps to cancellation)
    await client.query(
      `UPDATE quotation SET status = 'GENERATED' WHERE status IN ('SENT', 'APPROVED')`,
    ).catch(() => {});
    await client.query(
      `UPDATE quotation SET status = 'CANCELLED' WHERE status = 'REJECTED'`,
    ).catch(() => {});
    // READY_FOR_DISPATCH → READY (renamed for consistency with frontend filter keys)
    await client.query(
      `UPDATE orders SET status = 'READY' WHERE status = 'READY_FOR_DISPATCH'`,
    ).catch(() => {});
    // Quotation-derived orders were incorrectly defaulted to PENDING_APPROVAL before
    // the fix that passes status='GENERATED' at conversion time. Migrate them back.
    // Safe: sendForApproval() was a no-op before the fix, so none could have legitimately
    // progressed from GENERATED → PENDING_APPROVAL via the state machine.
    await client.query(
      `UPDATE orders SET status = 'GENERATED' WHERE quotation_id IS NOT NULL AND status = 'PENDING_APPROVAL'`,
    ).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureShopifyCatalogClassificationColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    // Nullable, no default — category must be assigned manually after sync
    await client.query(
      `ALTER TABLE shopify_catalog_items ADD COLUMN IF NOT EXISTS main_category_type VARCHAR(20)`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE shopify_catalog_items ADD COLUMN IF NOT EXISTS service_subtype VARCHAR(30)`,
    ).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureServiceItemClassificationColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    const cols = [
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS main_category_type  VARCHAR(20) NOT NULL DEFAULT 'TRADING'`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS service_subtype     VARCHAR(30)`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS boq_status          VARCHAR(20) NOT NULL DEFAULT 'NOT_CREATED'`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS requires_production BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS requires_purchase   BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS stock_tracking_type VARCHAR(20) NOT NULL DEFAULT 'PCS'`,
      `ALTER TABLE service_items ADD COLUMN IF NOT EXISTS is_raw_material     BOOLEAN NOT NULL DEFAULT FALSE`,
    ];
    for (const sql of cols) {
      await client.query(sql).catch(() => {});
    }
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureItemColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    const cols = [
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS source              VARCHAR`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS "shopifyVariantId"  VARCHAR`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS unit                 VARCHAR NOT NULL DEFAULT 'Nos'`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS image                TEXT`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS retail_price         DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS wholesale_price      DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `ALTER TABLE item ADD COLUMN IF NOT EXISTS "syncIgnored"        BOOLEAN NOT NULL DEFAULT FALSE`,
    ];
    for (const sql of cols) {
      await client.query(sql).catch(() => {});
    }
    // Normalize source values: null/service → manual, keep shopify as-is
    await client.query(
      `UPDATE item SET source = 'manual' WHERE source IS NULL OR LOWER(source) = 'service'`,
    ).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureKpiTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS kpi_snapshots (
        id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        scope        VARCHAR(10)  NOT NULL,
        scope_id     INT,
        module       VARCHAR(20)  NOT NULL,
        metric_key   VARCHAR(60)  NOT NULL,
        metric_value NUMERIC(14,4) NOT NULL,
        metric_unit  VARCHAR(20),
        period       VARCHAR(10)  NOT NULL,
        period_start TIMESTAMPTZ  NOT NULL,
        period_end   TIMESTAMPTZ  NOT NULL,
        metadata     JSONB,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kpi_scope        ON kpi_snapshots(scope, scope_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kpi_module       ON kpi_snapshots(module)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kpi_metric       ON kpi_snapshots(metric_key)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kpi_period       ON kpi_snapshots(period)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kpi_period_start ON kpi_snapshots(period_start)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_snapshot
        ON kpi_snapshots(scope, COALESCE(scope_id::text,''), module, metric_key, period, period_start)
    `);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureSlaTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS sla_events (
        id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        module               VARCHAR(20)  NOT NULL,
        entity_type          VARCHAR(30)  NOT NULL,
        entity_id            INT          NOT NULL,
        entity_label         VARCHAR(200) NOT NULL,
        assigned_user_id     INT,
        assigned_role        VARCHAR(50),
        status               VARCHAR(10)  NOT NULL DEFAULT 'ACTIVE',
        priority             VARCHAR(8)   NOT NULL DEFAULT 'MEDIUM',
        sla_deadline         TIMESTAMPTZ  NOT NULL,
        warning_at           TIMESTAMPTZ,
        escalation_level     INT          NOT NULL DEFAULT 0,
        escalated_at         TIMESTAMPTZ,
        resolved_at          TIMESTAMPTZ,
        last_notification_at TIMESTAMPTZ,
        metadata             JSONB,
        created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sla_status   ON sla_events(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sla_entity   ON sla_events(entity_type, entity_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sla_user     ON sla_events(assigned_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sla_deadline ON sla_events(sla_deadline)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureLogsTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id         SERIAL PRIMARY KEY,
        action     TEXT NOT NULL,
        payload    JSONB,
        user_id    INT,
        ip         TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_action     ON logs(action)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC)`);
    console.log('📋 LOGS TABLE READY');
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureDepartmentTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR NOT NULL,
        code              VARCHAR UNIQUE NOT NULL,
        daily_capacity    DOUBLE PRECISION,
        capacity_unit     VARCHAR,
        manpower_capacity INT,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_departments_active ON departments(active)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureBoqTables(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS manufacturing_boqs (
        id         SERIAL PRIMARY KEY,
        item_id    INT NOT NULL,
        version    INT NOT NULL DEFAULT 1,
        status     VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        notes      TEXT,
        created_by INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mboq_item_id ON manufacturing_boqs(item_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS manufacturing_boq_items (
        id                   SERIAL PRIMARY KEY,
        boq_id               INT NOT NULL REFERENCES manufacturing_boqs(id) ON DELETE CASCADE,
        raw_material_item_id INT NOT NULL,
        department_id        INT NOT NULL,
        consumption_type     VARCHAR(20) NOT NULL,
        qty_per_unit         DOUBLE PRECISION NOT NULL,
        wastage_percent      DOUBLE PRECISION NOT NULL DEFAULT 0,
        width                DOUBLE PRECISION,
        height               DOUBLE PRECISION,
        sheet_size           VARCHAR(50),
        formula_type         VARCHAR(30),
        preferred_vendor     VARCHAR,
        notes                TEXT,
        image                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mboqi_boq_id ON manufacturing_boq_items(boq_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mboqi_raw_mat ON manufacturing_boq_items(raw_material_item_id)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureProductionExecutionTables(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();

    await client.query(`
      CREATE TABLE IF NOT EXISTS production_execution_jobs (
        id             SERIAL PRIMARY KEY,
        order_id       INT NOT NULL,
        order_item_id  INT NOT NULL,
        item_id        INT NOT NULL,
        boq_id         INT NOT NULL,
        qty            DOUBLE PRECISION NOT NULL,
        completed_qty  DOUBLE PRECISION NOT NULL DEFAULT 0,
        rejected_qty   DOUBLE PRECISION NOT NULL DEFAULT 0,
        status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        priority       VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
        started_at     TIMESTAMPTZ,
        completed_at   TIMESTAMPTZ,
        notes          TEXT,
        created_by     INT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pej_order_id  ON production_execution_jobs(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pej_status    ON production_execution_jobs(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pej_item_id   ON production_execution_jobs(item_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS production_job_stages (
        id                 SERIAL PRIMARY KEY,
        production_job_id  INT NOT NULL REFERENCES production_execution_jobs(id) ON DELETE CASCADE,
        department_id      INT NOT NULL,
        sequence_no        INT NOT NULL,
        status             VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        assigned_user_id   INT,
        planned_qty        DOUBLE PRECISION NOT NULL,
        completed_qty      DOUBLE PRECISION NOT NULL DEFAULT 0,
        rejected_qty       DOUBLE PRECISION NOT NULL DEFAULT 0,
        started_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        remarks            TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pjs_job_id     ON production_job_stages(production_job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pjs_dept_id    ON production_job_stages(department_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pjs_user_id    ON production_job_stages(assigned_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pjs_status     ON production_job_stages(status)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pjs_job_seq ON production_job_stages(production_job_id, sequence_no)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureProductionStageRefinements(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    // New timer-tracking columns
    const cols = [
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS hold_started_at        TIMESTAMPTZ`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS total_hold_minutes     FLOAT NOT NULL DEFAULT 0`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS stopped_at             TIMESTAMPTZ`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS actual_working_minutes FLOAT NOT NULL DEFAULT 0`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS hold_reason            TEXT`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS moved_by               INT`,
      `ALTER TABLE production_job_stages ADD COLUMN IF NOT EXISTS moved_at               TIMESTAMPTZ`,
    ];
    for (const sql of cols) {
      await client.query(sql).catch(() => {});
    }
    // Migrate legacy status values → new canonical values
    await client.query(
      `UPDATE production_job_stages SET status = 'WORKING'  WHERE status = 'IN_PROGRESS'`,
    ).catch(() => {});
    await client.query(
      `UPDATE production_job_stages SET status = 'ON_HOLD' WHERE status = 'HOLD'`,
    ).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureLeadQualityColumns(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(
      `ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_quality  VARCHAR(20)`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE leads ADD COLUMN IF NOT EXISTS quality_score INT`,
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_leads_quality ON leads(lead_quality)`,
    ).catch(() => {});
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensurePurchaseRequirementsTable(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requirements (
        id            SERIAL PRIMARY KEY,
        item_id       INT NOT NULL,
        warehouse_id  INT,
        source_type   VARCHAR(20) NOT NULL DEFAULT 'ORDER',
        source_id     INT,
        required_qty  DOUBLE PRECISION NOT NULL,
        available_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        shortage_qty  DOUBLE PRECISION NOT NULL,
        unit          VARCHAR(20) NOT NULL DEFAULT 'PCS',
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        priority      VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
        notes         TEXT,
        created_by    INT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_item_id    ON purchase_requirements(item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_source     ON purchase_requirements(source_type, source_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_status     ON purchase_requirements(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_priority   ON purchase_requirements(priority)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_created_at ON purchase_requirements(created_at DESC)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureInventoryTables(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR NOT NULL,
        code       VARCHAR UNIQUE NOT NULL,
        type       VARCHAR NOT NULL DEFAULT 'GENERAL',
        active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_warehouses_active ON warehouses(active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_warehouses_type   ON warehouses(type)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id               SERIAL PRIMARY KEY,
        item_id          INT NOT NULL,
        warehouse_id     INT NOT NULL REFERENCES warehouses(id),
        transaction_type VARCHAR(30) NOT NULL,
        direction        VARCHAR(10) NOT NULL,
        qty              DOUBLE PRECISION NOT NULL,
        unit             VARCHAR(20) NOT NULL DEFAULT 'PCS',
        rate             DOUBLE PRECISION,
        reference_type   VARCHAR(30),
        reference_id     INT,
        notes            TEXT,
        created_by       INT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_tx_item_id      ON inventory_transactions(item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_tx_warehouse_id ON inventory_transactions(warehouse_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_tx_type         ON inventory_transactions(transaction_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_tx_direction    ON inventory_transactions(direction)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_tx_created_at   ON inventory_transactions(created_at DESC)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function ensureExplosionTables(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_material_requirements (
        id                    SERIAL PRIMARY KEY,
        order_id              INT NOT NULL,
        order_item_id         INT NOT NULL,
        item_id               INT NOT NULL,
        raw_material_item_id  INT NOT NULL,
        boq_item_id           INT,
        required_qty          DOUBLE PRECISION NOT NULL,
        consumption_type      VARCHAR(20) NOT NULL,
        wastage_percent       DOUBLE PRECISION NOT NULL DEFAULT 0,
        calculated_qty        DOUBLE PRECISION NOT NULL,
        status                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        notes                 TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_omr_order_id        ON order_material_requirements(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_omr_raw_material_id ON order_material_requirements(raw_material_item_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS department_workloads (
        id             SERIAL PRIMARY KEY,
        order_id       INT NOT NULL,
        order_item_id  INT NOT NULL,
        department_id  INT NOT NULL,
        boq_item_id    INT,
        workload_qty   DOUBLE PRECISION NOT NULL,
        workload_unit  VARCHAR(20) NOT NULL,
        estimated_hours DOUBLE PRECISION,
        status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dw_order_id      ON department_workloads(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dw_department_id ON department_workloads(department_id)`);
  } finally {
    await client?.end().catch(() => {});
  }
}

/**
 * Validates that required columns exist before accepting traffic.
 * Exits with a clear error only if the schema is provably out of date.
 * Connection failures are non-fatal — the app may still work if TypeORM connects.
 */
async function validateSchema(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let client: Client | null = null;
  try {
    client = await createMigrationClient();
    const required: Array<{ table: string; column: string; migration: string }> = [
      { table: 'leads', column: 'stage', migration: 'npm run migrate:lead-stage' },
    ];

    const missing: string[] = [];
    for (const { table, column, migration } of required) {
      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      );
      if (rows.length === 0) {
        missing.push(`  ✗ ${table}.${column}  →  run: ${migration}`);
      }
    }

    if (missing.length > 0) {
      logger.error('❌ STARTUP BLOCKED — schema is out of date. Run the missing migrations:\n' + missing.join('\n'));
      process.exit(1);
    }

    logger.log('✅ Schema validated');
  } finally {
    await client?.end().catch(() => {});
  }
}

async function bootstrap() {
  // ── Startup banner ─────────────────────────────────────────────────────────
  const appVersion = process.env.APP_VERSION ?? 'dev';
  const deployedAt = process.env.DEPLOYED_AT ?? new Date().toISOString();
  logger.log('═══════════════════════════════════════════════════');
  logger.log(`  Saachu App Backend   ${appVersion}`);
  logger.log(`  Env: ${process.env.NODE_ENV ?? 'development'}   PID: ${process.pid}`);
  logger.log(`  Deployed: ${deployedAt}`);
  logger.log('═══════════════════════════════════════════════════');

  // ── Dev-only: early duplicate-startup detection ────────────────────────────
  // Probe the port before any heavy initialization (migrations, NestJS module
  // graph, WhatsApp client). If something is already listening we exit cleanly
  // with code 0 so nodemon doesn't treat it as a crash and spin-retry.
  // Production intentionally skips this — it must fail hard if the port is taken.
  const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';
  if (isDev) {
    const preferred = parseInt(String(process.env.PORT || 4000), 10);
    // Stabilization delay: nodemon sends SIGTERM then immediately spawns the
    // new process. Without a short wait the old process may still hold the
    // socket in TIME_WAIT, giving a false-positive "port occupied" reading.
    await delay(600);
    if (await isPortOccupied(preferred)) {
      logger.warn(
        `[Bootstrap] Backend already running on port ${preferred} — duplicate startup detected. Skipping.`,
      );
      process.exit(0);
    }
  }

  // ── Required env var validation ────────────────────────────────────────────
  // Fail loudly before any connection is attempted so the Render log shows
  // exactly which secret is missing rather than an obscure downstream error.
  const REQUIRED_ENV: string[] = ['DATABASE_URL', 'JWT_SECRET'];
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    logger.error(`❌ STARTUP BLOCKED — missing required env vars: ${missingEnv.join(', ')}`);
    logger.error('   Set these in the Render dashboard → Environment → Add Env Var');
    process.exit(1);
  }
  logger.log('✅ Required env vars present');

  const rawDbUrl = process.env.DATABASE_URL ?? '';
  const dbUrl    = sanitizeDatabaseUrl(rawDbUrl);

  if (dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')) {
    if (process.env.ALLOW_LOCAL_DB !== 'true') {
      console.error('❌ Local DB is not allowed. Use Neon DB.');
      process.exit(1);
    }
    console.warn('⚠️  ALLOW_LOCAL_DB=true — running with local database.');
  }

  logger.log(`DB (sanitized): ${redactDatabaseUrl(dbUrl) || '(not set)'}`);

  try {
    await ensurePromotionTable();
    console.log('✅ PROMOTION TABLE READY');
  } catch (err: any) {
    logger.error('Promotion migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureAnalyticsTable();
  } catch (err: any) {
    logger.error('Analytics migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureLogsTable();
  } catch (err: any) {
    logger.error('Logs migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureDispatchTable();
    logger.log('✅ Dispatch table ready');
  } catch (err: any) {
    logger.error('Dispatch migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureWhatsappSessionColumns();
    logger.log('✅ WhatsApp session columns ready');
  } catch (err: any) {
    logger.error('WhatsApp session migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureNotificationColumns();
    logger.log('✅ Notification columns ready');
  } catch (err: any) {
    logger.error('Notification column migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureOrderColumns();
    logger.log('✅ Order columns ready (created_at, quotation_id)');
  } catch (err: any) {
    logger.error('Order column migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureQuotationColumns();
    logger.log('✅ Quotation columns ready (converted_order_id)');
  } catch (err: any) {
    logger.error('Quotation column migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureNewItemTables();
    await ensureItemColumns();
    logger.log('✅ Item columns ready (source, shopifyVariantId, unit, image, retail_price, wholesale_price)');
  } catch (err: any) {
    logger.error('Item column migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureServiceItemClassificationColumns();
    logger.log('✅ Service item classification columns ready');
  } catch (err: any) {
    logger.error('Service item classification migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureShopifyCatalogClassificationColumns();
    logger.log('✅ Shopify catalog classification columns ready');
  } catch (err: any) {
    logger.error('Shopify catalog classification migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureKpiTable();
    logger.log('✅ KPI table ready');
  } catch (err: any) {
    logger.error('KPI table migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureSlaTable();
    logger.log('✅ SLA table ready');
  } catch (err: any) {
    logger.error('SLA table migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureActivityTable();
    logger.log('✅ Activity table ready');
  } catch (err: any) {
    logger.error('Activity table migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureDepartmentTable();
    logger.log('✅ Departments table ready');
  } catch (err: any) {
    logger.error('Departments migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureBoqTables();
    logger.log('✅ BOQ tables ready');
  } catch (err: any) {
    logger.error('BOQ migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureExplosionTables();
    logger.log('✅ Order explosion tables ready');
  } catch (err: any) {
    logger.error('Explosion table migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureInventoryTables();
    logger.log('✅ Inventory tables ready (warehouses, inventory_transactions)');
  } catch (err: any) {
    logger.error('Inventory migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureProductionExecutionTables();
    logger.log('✅ Production execution tables ready (production_execution_jobs, production_job_stages)');
  } catch (err: any) {
    logger.error('Production execution migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureProductionStageRefinements();
    logger.log('✅ Production stage refinements ready (timer columns, status migration)');
  } catch (err: any) {
    logger.error('Production stage refinements migration failed (non-fatal):', err?.message);
  }

  try {
    await ensurePurchaseRequirementsTable();
    logger.log('✅ Purchase requirements table ready');
  } catch (err: any) {
    logger.error('Purchase requirements migration failed (non-fatal):', err?.message);
  }

  try {
    await ensureLeadQualityColumns();
    logger.log('✅ Lead quality columns ready (lead_quality, quality_score)');
  } catch (err: any) {
    logger.error('Lead quality migration failed (non-fatal):', err?.message);
  }

  try {
    await validateSchema();
  } catch (err: any) {
    logger.error('Schema validation failed (non-fatal) — app will start anyway:', err?.message);
  }

  const app = await NestFactory.create(AppModule, { rawBody: true });
  console.log('🚀 PROMOTION ROUTE READY');

  // Idempotent close — must be installed before enableShutdownHooks() wires signal handlers.
  let isShuttingDown = false;
  const nestClose = app.close.bind(app);
  app.close = async () => {
    if (isShuttingDown) {
      logger.warn('[Bootstrap] app.close() skipped — shutdown already in progress');
      return;
    }
    isShuttingDown = true;
    logger.log('[Bootstrap] Closing application…');
    try {
      await nestClose();
    } catch (e: any) {
      logger.error('[Bootstrap] Error during shutdown', e?.stack);
    } finally {
      logger.log('[Bootstrap] Shutdown complete');
      setImmediate(() => process.exit(0));
    }
  };

  // Single shutdown owner: Nest listens for SIGTERM/SIGINT/SIGHUP and calls app.close() once.
  // Do NOT add separate process.on('SIGTERM') handlers — that double-closes the TypeORM pool.
  app.enableShutdownHooks();

  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Trust the first proxy hop (Render, Cloudflare) so ThrottlerGuard sees real client IPs
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Always-allowed origins (dev + known prod domains)
  const SAFE_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:4000',
    'https://heshstore.in',
    'https://www.heshstore.in',
  ];

  // CORS_ORIGIN env var: '*' = wildcard, comma-separated list = merge with safe defaults
  const corsRaw = (process.env.CORS_ORIGIN || '').trim();
  const corsOrigin: boolean | string[] =
    corsRaw === '*'
      ? true   // wildcard (dev only)
      : [
          ...new Set([
            ...SAFE_ORIGINS,
            ...corsRaw.split(',').map((s) => s.trim()).filter(Boolean),
          ]),
        ];

  logger.log(`CORS allowed origins: ${corsOrigin === true ? '*' : (corsOrigin as string[]).join(', ')}`);

  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });

  const preferred = parseInt(String(process.env.PORT || 4000), 10);
  const port      = await listenWithFallback(app, preferred);

  logger.log(`[Bootstrap] Application running at http://localhost:${port}  (PID ${process.pid})`);

  if (port !== preferred) {
    logger.warn(
      `[Bootstrap] Using port ${port} (${preferred} was occupied). ` +
      `To reclaim ${preferred}: lsof -ti :${preferred} | xargs kill -9`,
    );
  }

  // Surface unhandled promise rejections so they appear in logs instead of disappearing silently
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('[Bootstrap] Unhandled rejection', String((reason as any)?.stack ?? reason));
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error('[Bootstrap] Uncaught exception', err.stack);
    // Don't exit — let the process recover unless it's truly fatal
  });
}

bootstrap();
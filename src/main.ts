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

/** Returns true if nothing is listening on `port`. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => { probe.close(); resolve(true); });
    probe.listen(port, '0.0.0.0');
  });
}

/** Scans from `preferred` upward until a free port is found (max 16 attempts). */
async function findFreePort(preferred: number): Promise<number> {
  for (let i = 0; i < 16; i++) {
    const candidate = preferred + i;
    if (await isPortFree(candidate)) return candidate;
    logger.warn(`Port ${candidate} is occupied — trying ${candidate + 1}…`);
  }
  throw new Error(
    `No free port found in range ${preferred}–${preferred + 15}. ` +
    `Run: lsof -ti :${preferred} | xargs kill -9`,
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
    await validateSchema();
  } catch (err: any) {
    logger.error('Schema validation failed (non-fatal) — app will start anyway:', err?.message);
  }

  const app = await NestFactory.create(AppModule, { rawBody: true });
  console.log('🚀 PROMOTION ROUTE READY');

  // Triggers onModuleDestroy() on every module (WhatsApp client, DB) when the process exits
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
  const port = await findFreePort(preferred);

  await app.listen(port);
  logger.log(`Server running  →  http://localhost:${port}  (PID ${process.pid})`);

  if (port !== preferred) {
    logger.warn(
      `Started on port ${port} instead of ${preferred}. ` +
      `To reclaim ${preferred}: lsof -ti :${preferred} | xargs kill -9`,
    );
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // app.close() triggers onModuleDestroy on all modules — WhatsApp client
  // is destroyed and TypeORM closes the DB pool automatically.
  const shutdown = async (signal: string) => {
    logger.log(`[Bootstrap] ${signal} received — shutting down gracefully`);
    try {
      await app.close();
      logger.log('[Bootstrap] Shutdown complete');
    } catch (e: any) {
      logger.error('[Bootstrap] Error during shutdown', e?.stack);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT',  () => { void shutdown('SIGINT');  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

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
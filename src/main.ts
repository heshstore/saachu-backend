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

/** Scans from `preferred` upward until a free port is found (max 5 attempts). */
async function findFreePort(preferred: number): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const candidate = preferred + i;
    if (await isPortFree(candidate)) return candidate;
    logger.warn(`Port ${candidate} is occupied — trying ${candidate + 1}…`);
  }
  throw new Error(
    `No free port found in range ${preferred}–${preferred + 4}. ` +
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

  const corsRaw = (process.env.CORS_ORIGIN || '').trim();
  // '*' is only for local dev; unset CORS_ORIGIN rejects all cross-origin requests in production
  const corsOrigin: boolean | string | string[] =
    corsRaw === '*'
      ? true
      : corsRaw.includes(',')
        ? corsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : corsRaw || false;

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:4000',
      'https://heshstore.in',
      'https://www.heshstore.in',
    ],
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
import * as dotenv from 'dotenv';
dotenv.config();
import * as net from 'net';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { LoggingInterceptor } from './common/logging.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

const logger = new Logger('Bootstrap');

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

async function bootstrap() {
  console.log('DB CONNECTED TO:', process.env.DATABASE_URL?.replace(/:\/\/[^@]+@/, '://***@') ?? '(not set)');

  const app = await NestFactory.create(AppModule, { rawBody: true });

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
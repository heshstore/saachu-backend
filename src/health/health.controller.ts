import {
  Controller,
  Get,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';
import { DbHealthService } from '../shared/db-health.service';

const BOOT_TIME = new Date();

@Controller('health')
export class HealthController implements OnApplicationBootstrap {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly dbHealth: DbHealthService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows: Record<string, string>[] = await this.ds.query(
        `SELECT current_database() AS db, current_schema() AS schema`,
      );
      const r = rows[0] ?? {};
      const opts = (this.ds.driver as any)?.options ?? {};
      this.logger.log(
        `[DB] Connected — db=${r['db'] ?? opts.database ?? '?'} ` +
          `host=${opts.host ?? '?'} ` +
          `pool_max=${opts.extra?.max ?? 10} ` +
          `retryAttempts=${(this.ds as any)?.options?.retryAttempts ?? 20} ` +
          `keepAlive=true`,
      );
      this.dbHealth.recordSuccess();
    } catch (err: any) {
      this.dbHealth.handleError(err, 'HealthController.startup');
    }
  }

  /** Full health check — db ping, uptime, memory, whatsapp state, version. */
  @Public()
  @Get()
  async getHealth() {
    const dbOk = await this.ds
      .query('SELECT 1')
      .then(() => {
        this.dbHealth.recordSuccess();
        return true;
      })
      .catch(() => false);

    let waDbStatus = 'UNKNOWN';
    try {
      const rows = await this.ds.query(
        `SELECT status FROM whatsapp_sessions ORDER BY last_active_at DESC LIMIT 1`,
      );
      waDbStatus = rows[0]?.status ?? 'NO_SESSION';
    } catch {
      waDbStatus = 'DB_ERROR';
    }

    const waReady = waDbStatus === 'CONNECTED';
    const mem = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());

    return {
      // ── Simplified status contract ─────────────────────────────────────────
      db: dbOk ? 'up' : 'down',
      whatsapp: waReady ? 'ready' : 'connecting',
      auth: dbOk ? 'up' : 'degraded',
      // ── Detailed fields ───────────────────────────────────────────────────
      status: dbOk ? 'ok' : 'degraded',
      app_version: process.env.APP_VERSION ?? 'dev',
      deployed_at: process.env.DEPLOYED_AT ?? null,
      node_env: process.env.NODE_ENV ?? 'development',
      boot_time: BOOT_TIME.toISOString(),
      uptime_seconds: uptimeSec,
      database: dbOk ? 'connected' : 'error',
      whatsapp_status: waDbStatus,
      memory: {
        rss_mb: Math.round(mem.rss / 1_048_576),
        heap_used_mb: Math.round(mem.heapUsed / 1_048_576),
        heap_total_mb: Math.round(mem.heapTotal / 1_048_576),
      },
    };
  }

  /** DB connectivity health — reflects real-time status from scheduler observations. */
  @Public()
  @Get('db')
  getDbHealth() {
    return this.dbHealth.getStatus();
  }

  /** Lightweight version probe — safe to call from CI/deployment scripts. */
  @Public()
  @Get('version')
  getVersion() {
    return {
      backend_version: process.env.APP_VERSION ?? 'dev',
      deployed_at: process.env.DEPLOYED_AT ?? null,
      node_env: process.env.NODE_ENV ?? 'development',
    };
  }
}

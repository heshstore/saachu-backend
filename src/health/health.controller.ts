import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';

const BOOT_TIME = new Date();

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Full health check — db ping, uptime, memory, whatsapp state, version. */
  @Public()
  @Get()
  async getHealth() {
    const dbOk = await this.ds.query('SELECT 1').then(() => true).catch(() => false);

    let waDbStatus = 'UNKNOWN';
    try {
      const rows = await this.ds.query(
        `SELECT status FROM whatsapp_sessions ORDER BY last_active_at DESC LIMIT 1`,
      );
      waDbStatus = rows[0]?.status ?? 'NO_SESSION';
    } catch {
      waDbStatus = 'DB_ERROR';
    }

    const waReady   = waDbStatus === 'CONNECTED';
    const mem       = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());

    return {
      // ── Simplified status contract ─────────────────────────────────────────
      db:       dbOk   ? 'up'       : 'down',
      whatsapp: waReady ? 'ready'   : 'connecting',
      auth:     dbOk   ? 'up'       : 'degraded',
      // ── Detailed fields ───────────────────────────────────────────────────
      status:          dbOk ? 'ok' : 'degraded',
      app_version:     process.env.APP_VERSION  ?? 'dev',
      deployed_at:     process.env.DEPLOYED_AT  ?? null,
      node_env:        process.env.NODE_ENV      ?? 'development',
      boot_time:       BOOT_TIME.toISOString(),
      uptime_seconds:  uptimeSec,
      database:        dbOk ? 'connected' : 'error',
      whatsapp_status: waDbStatus,
      memory: {
        rss_mb:        Math.round(mem.rss         / 1_048_576),
        heap_used_mb:  Math.round(mem.heapUsed    / 1_048_576),
        heap_total_mb: Math.round(mem.heapTotal   / 1_048_576),
      },
    };
  }

  /** Lightweight version probe — safe to call from CI/deployment scripts. */
  @Public()
  @Get('version')
  getVersion() {
    return {
      backend_version: process.env.APP_VERSION ?? 'dev',
      deployed_at:     process.env.DEPLOYED_AT ?? null,
      node_env:        process.env.NODE_ENV    ?? 'development',
    };
  }
}

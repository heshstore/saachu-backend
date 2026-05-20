import { Injectable, Logger } from '@nestjs/common';

const THROTTLE_MS = 60_000; // emit at most one DB-outage warning per 60s

const DB_ERROR_PATTERNS = [
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'connection terminated', 'Connection terminated',
  'connection refused', 'getaddrinfo',
  'read ECONNRESET', 'write ECONNRESET',
  'pool timeout', 'Connection pool timeout',
  'Client was closed',
];

function isDbConnectivityError(err: any): boolean {
  const text = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.name ?? ''}`;
  return DB_ERROR_PATTERNS.some((p) => text.includes(p));
}

export interface DbHealthStatus {
  healthy: boolean;
  lastFailureAt: string | null;
  lastRecoveryAt: string | null;
}

@Injectable()
export class DbHealthService {
  private readonly logger = new Logger(DbHealthService.name);

  private _healthy = true;
  private _lastFailureAt: Date | null = null;
  private _lastRecoveryAt: Date | null = null;
  private _lastWarnAt = 0;

  get healthy(): boolean {
    return this._healthy;
  }

  /**
   * Call at the end of a successful scheduler cycle.
   * Logs a recovery message the first time after an outage.
   */
  recordSuccess(): void {
    if (!this._healthy) {
      this._healthy = true;
      this._lastRecoveryAt = new Date();
      this.logger.log('[DbHealth] ✓ Database connection restored');
    }
  }

  /**
   * Call from a scheduler's catch block.
   *
   * - DB connectivity errors: marked unhealthy, single throttled warning per 60s.
   * - Non-connectivity errors (application bugs etc.): logged normally every time.
   */
  handleError(err: any, context: string): void {
    if (isDbConnectivityError(err)) {
      this._healthy = false;
      this._lastFailureAt = new Date();
      const now = Date.now();
      if ((now - this._lastWarnAt) >= THROTTLE_MS) {
        this._lastWarnAt = now;
        this.logger.warn(
          `[${context}] Database temporarily unavailable — scheduler cycle skipped`,
        );
      }
    } else {
      this.logger.error(`[${context}] ${err?.message ?? err}`, err?.stack);
    }
  }

  getStatus(): DbHealthStatus {
    return {
      healthy:        this._healthy,
      lastFailureAt:  this._lastFailureAt?.toISOString()  ?? null,
      lastRecoveryAt: this._lastRecoveryAt?.toISOString() ?? null,
    };
  }
}

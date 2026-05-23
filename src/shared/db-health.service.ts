import { Injectable, Logger } from '@nestjs/common';
import { isTransientDbError } from './db-error.util';

const THROTTLE_MS        = 60_000; // emit at most one DB-outage warning per 60s
const DEGRADED_WINDOW_MS = 5 * 60_000; // show 'degraded' for 5 min after recovery

export type DbStatus = 'healthy' | 'degraded' | 'disconnected';

export interface DbHealthStatus {
  status:         DbStatus;
  healthy:        boolean;
  lastFailureAt:  string | null;
  lastRecoveryAt: string | null;
}

@Injectable()
export class DbHealthService {
  private readonly logger = new Logger(DbHealthService.name);

  private _healthy        = true;
  private _lastFailureAt: Date | null   = null;
  private _lastRecoveryAt: Date | null  = null;
  private _lastWarnAt     = 0;

  get healthy(): boolean {
    return this._healthy;
  }

  /**
   * Call at the end of a successful scheduler cycle.
   * Logs a recovery message the first time after an outage.
   */
  recordSuccess(): void {
    if (!this._healthy) {
      this._healthy       = true;
      this._lastRecoveryAt = new Date();
      this.logger.log('[DB_HEALTH] Database connection restored');
    }
  }

  /**
   * Call from a scheduler's catch block.
   *
   * - Transient connectivity errors: marked unhealthy, one throttled warning per 60s.
   * - Non-transient errors (application bugs etc.): logged every time.
   */
  handleError(err: any, context: string): void {
    if (isTransientDbError(err)) {
      this._healthy      = false;
      this._lastFailureAt = new Date();
      const now = Date.now();
      if ((now - this._lastWarnAt) >= THROTTLE_MS) {
        this._lastWarnAt = now;
        this.logger.warn(
          `[DB_WARN] Neon temporarily unreachable — suppressing repeated logs for 60s (context: ${context})`,
        );
      }
    } else {
      this.logger.error(`[${context}] ${err?.message ?? err}`, err?.stack);
    }
  }

  getStatus(): DbHealthStatus {
    let status: DbStatus;
    if (!this._healthy) {
      status = 'disconnected';
    } else if (
      this._lastFailureAt !== null &&
      Date.now() - this._lastFailureAt.getTime() < DEGRADED_WINDOW_MS
    ) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      healthy:        this._healthy,
      lastFailureAt:  this._lastFailureAt?.toISOString()  ?? null,
      lastRecoveryAt: this._lastRecoveryAt?.toISOString() ?? null,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Log } from './entities/log.entity';

export enum LogAction {
  LEAD_CREATED        = 'LEAD_CREATED',
  LEAD_UPDATED        = 'LEAD_UPDATED',
  LEAD_ASSIGNED       = 'LEAD_ASSIGNED',
  PROMOTION_CAPTURED  = 'PROMOTION_CAPTURED',
  PROMOTION_SKIPPED   = 'PROMOTION_SKIPPED',
  ANALYTICS_TRACKED   = 'ANALYTICS_TRACKED',
  ERROR               = 'ERROR',
}

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(
    @InjectRepository(Log)
    private readonly repo: Repository<Log>,
    private readonly dataSource: DataSource,
  ) {}

  async ensureTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id         SERIAL PRIMARY KEY,
        action     TEXT NOT NULL,
        payload    JSONB,
        user_id    INT,
        ip         TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_logs_action     ON logs(action)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC)`,
    );
  }

  /**
   * Fire-and-forget logger. Never throws — a logging failure must not
   * break the primary request flow.
   */
  log(
    action: LogAction | string,
    payload?: Record<string, any>,
    userId?: number | null,
    ip?: string,
  ): void {
    this.repo
      .save(
        this.repo.create({
          action,
          payload:  payload  ?? null,
          user_id:  userId   ?? null,
          ip:       ip       ?? null,
        }),
      )
      .catch((err) =>
        this.logger.error(`Failed to write log entry action=${action}: ${err?.message}`),
      );
  }

  async findAll(limit = 200): Promise<Log[]> {
    return this.repo.find({
      order: { created_at: 'DESC' },
      take:  Math.min(limit, 1000),
    });
  }

  async findByAction(action: string, limit = 100): Promise<Log[]> {
    return this.repo.find({
      where: { action },
      order: { created_at: 'DESC' },
      take:  Math.min(limit, 1000),
    });
  }
}

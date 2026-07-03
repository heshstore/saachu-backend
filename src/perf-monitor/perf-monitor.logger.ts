import { Logger } from 'typeorm';
import { perfMonitorInstance } from './perf-monitor.service';

// Implements TypeORM Logger interface — all methods are synchronous no-ops
// except the three that record metrics into the in-memory service.
// No I/O. No console output. No DB writes.
export class PerfMonitorLogger implements Logger {
  logQuery(query: string): void {
    perfMonitorInstance.recordQuery(query);
  }

  logQueryError(): void {
    perfMonitorInstance.recordQueryError();
  }

  logQuerySlow(time: number, query: string): void {
    perfMonitorInstance.recordSlowQuery(time, query);
  }

  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

export const perfMonitorLogger = new PerfMonitorLogger();

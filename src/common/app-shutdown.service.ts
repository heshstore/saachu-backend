import { Injectable, BeforeApplicationShutdown, Logger } from '@nestjs/common';

/**
 * Lifecycle hook for graceful shutdown logging.
 * TypeORM pool closure is owned solely by TypeOrmModule — do not call dataSource.destroy() here.
 */
@Injectable()
export class AppShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Bootstrap');

  beforeApplicationShutdown(signal?: string): void {
    this.logger.log(
      `[Bootstrap] ${signal ?? 'shutdown'} — draining modules (WhatsApp, schedulers, TypeORM)`,
    );
  }
}

import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildEnvironmentSnapshot } from '../config/database-environment';

@Controller('health')
export class EnvironmentController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Admin environment visibility — database binding + record counts. */
  @Get('environment')
  async getEnvironment() {
    let connected = false;
    let customerCount: number | null = null;
    let promotionalCount: number | null = null;

    try {
      await this.ds.query('SELECT 1');
      connected = true;
      const rows: { c: string; p: string }[] = await this.ds.query(`
        SELECT
          (SELECT COUNT(*)::int FROM customer) AS c,
          (SELECT COUNT(*)::int FROM marketing_audience) AS p
      `);
      customerCount = parseInt(rows[0]?.c ?? '0', 10);
      promotionalCount = parseInt(rows[0]?.p ?? '0', 10);
    } catch {
      connected = false;
    }

    return buildEnvironmentSnapshot(connected, {
      customer: customerCount ?? 0,
      promotional: promotionalCount ?? 0,
    });
  }
}

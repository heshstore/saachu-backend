import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppService } from './app.service';
import { Public } from './auth/public.decorator';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Debugging endpoint — shows which PostgreSQL database this instance is connected to.
   *  Requires a valid JWT (no @Public) to prevent unauthenticated exposure. */
  @Get('debug/db')
  async debugDb() {
    const [{ current_database }] = await this.ds.query('SELECT current_database()');
    const [{ inet_server_addr }] = await this.ds.query('SELECT inet_server_addr()').catch(() => [{ inet_server_addr: 'n/a' }]);
    const url = process.env.DATABASE_URL ?? '(not set)';
    const sanitized = url.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
    return {
      current_database,
      server_addr: inet_server_addr,
      connection_string: sanitized,
      node_env: process.env.NODE_ENV ?? '(not set)',
    };
  }

  @Public()
  @Get('debug/leads')
  async debugLeads() {
    const [{ current_database }] = await this.ds.query('SELECT current_database()');

    const rows = await this.ds.query(`
      SELECT id, phone, product_interest, channel, created_at
      FROM leads
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log('DEBUG LEADS:', rows);

    return { current_database, count: rows.length, leads: rows };
  }
}

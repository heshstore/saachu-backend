import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const REQUIRED_TABLES = [
  'whatsapp_numbers',
  'marketing_templates',
  'marketing_campaigns',
  'marketing_audience',
  'whatsapp_message_queue',
  'whatsapp_message_logs',
  'whatsapp_replies',
  'engine_audit_logs',
] as const;

// Columns added after the base migration (phases 5–9) — the drift-prone ones.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  marketing_templates:    ['performance_weight', 'product_category'],
  marketing_audience:     ['is_test_contact', 'cooldown_until', 'fatigue_score'],
  whatsapp_numbers:       ['wa_state', 'warmup_level', 'risk_score', 'daily_sent', 'last_message_sent_at'],
  whatsapp_message_queue: ['attempt_count', 'priority', 'message_payload', 'number_id'],
  whatsapp_message_logs:  ['delivered_at', 'read_at', 'reply_received', 'reply_message', 'number_id'],
  engine_audit_logs:      ['metadata', 'score'],
  whatsapp_replies:       ['conversation_key'],
};

// Probing queries — each one selects only the critical column(s) with LIMIT 0.
// A missing column makes the query throw immediately; LIMIT 0 means zero I/O cost.
const PROBE_QUERIES: { label: string; sql: string }[] = [
  {
    label: 'marketing_templates.product_category',
    sql: 'SELECT product_category FROM marketing_templates LIMIT 0',
  },
  {
    label: 'marketing_audience.fatigue_score',
    sql: 'SELECT fatigue_score FROM marketing_audience LIMIT 0',
  },
  {
    label: 'marketing_audience.cooldown_until',
    sql: 'SELECT cooldown_until FROM marketing_audience LIMIT 0',
  },
  {
    label: 'marketing_templates.performance_weight',
    sql: 'SELECT performance_weight FROM marketing_templates LIMIT 0',
  },
  {
    label: 'whatsapp_numbers.warmup_level + risk_score',
    sql: 'SELECT warmup_level, risk_score FROM whatsapp_numbers LIMIT 0',
  },
];

@Injectable()
export class SchemaValidatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaValidatorService.name);

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this._logConnectionInfo();
      await this._checkInformationSchema();
      await this._runProbeQueries();
    } catch (err: any) {
      // Never crash the server — validation is advisory, not blocking.
      this.logger.error(`[SchemaValidator] Unexpected error: ${err?.message}`);
    }
  }

  // ── 1. Log exactly which database this process is connected to ───────────────

  private async _logConnectionInfo(): Promise<void> {
    const rows: Record<string, string>[] = await this.ds.query(`
      SELECT current_database() AS db,
             current_schema()   AS schema,
             inet_server_addr() AS host
    `);
    const r: Record<string, string> = rows[0] ?? {};
    const opts = (this.ds.driver as any)?.options ?? {};
    this.logger.log(
      `[SchemaValidator] Connected to DB: ${r['db'] ?? opts.database ?? '?'} ` +
      `| schema: ${r['schema'] ?? 'public'} ` +
      `| host: ${r['host'] ?? opts.host ?? '?'} ` +
      `| env: ${process.env.NODE_ENV ?? 'development'}`,
    );
  }

  // ── 2. information_schema check (existence-level) ────────────────────────────

  private async _checkInformationSchema(): Promise<void> {
    const missing: string[] = [];

    const tableRows: { table_name: string }[] = await this.ds.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES as unknown as string[]],
    );
    const presentTables = new Set(tableRows.map((r) => r.table_name));

    for (const t of REQUIRED_TABLES) {
      if (!presentTables.has(t)) missing.push(`TABLE ${t}`);
    }

    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!presentTables.has(table)) continue;
      const colRows: { column_name: string }[] = await this.ds.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name = ANY($2::text[])`,
        [table, columns],
      );
      const presentCols = new Set(colRows.map((r) => r.column_name));
      for (const col of columns) {
        if (!presentCols.has(col)) missing.push(`COLUMN ${table}.${col}`);
      }
    }

    if (missing.length === 0) {
      this.logger.log('[SchemaValidator] ✓ information_schema check passed — all tables and columns present');
      return;
    }

    this.logger.error(
      `[SchemaValidator] ❌ SCHEMA DRIFT DETECTED — ${missing.length} missing item(s):\n` +
      missing.map((m) => `  • ${m}`).join('\n') +
      `\n  → Fix: node scripts/migrate-whatsapp-engine-schema-final.js`,
    );
  }

  // ── 3. Hard probe queries — actual DB round-trips that will throw on mismatch ─

  private async _runProbeQueries(): Promise<void> {
    const failed: string[] = [];

    for (const probe of PROBE_QUERIES) {
      try {
        await this.ds.query(probe.sql);
        this.logger.log(`[SchemaValidator] ✓ probe OK: ${probe.label}`);
      } catch (err: any) {
        this.logger.error(
          `[SchemaValidator] ❌ probe FAILED: ${probe.label} — ${err?.message?.split('\n')[0]}`,
        );
        failed.push(probe.label);
      }
    }

    if (failed.length > 0) {
      this.logger.error(
        `[SchemaValidator] ❌ ${failed.length} probe(s) failed — DB schema does not match entity definitions.\n` +
        `  Failing: ${failed.join(', ')}\n` +
        `  → Fix: node scripts/migrate-whatsapp-engine-schema-final.js\n` +
        `  → Then restart the backend completely.`,
      );
    } else {
      this.logger.log('[SchemaValidator] ✓ All probe queries passed — entity schema matches DB');
    }
  }
}

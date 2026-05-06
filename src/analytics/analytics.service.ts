import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { TrackEventDto } from './dto/track-event.dto';
import { LogsService, LogAction } from '../logs/logs.service';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly repo: Repository<AnalyticsEvent>,
    private readonly dataSource: DataSource,
    private readonly logsService: LogsService,
  ) {}

  private async ensureTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id         SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        event      TEXT NOT NULL,
        product    TEXT,
        page_url   TEXT NOT NULL,
        device     TEXT,
        city       TEXT,
        source     TEXT,
        timestamp  TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_event   ON analytics_events(event)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_analytics_product ON analytics_events(product) WHERE product IS NOT NULL`,
    );
  }

  async track(dto: TrackEventDto): Promise<{ success: boolean }> {
    await this.ensureTable();

    const record = this.repo.create({
      session_id: dto.session_id,
      event:      dto.event,
      product:    dto.product    ?? null,
      page_url:   dto.page_url,
      device:     dto.device     ?? null,
      city:       dto.city       ?? null,
      source:     dto.source     ?? null,
      timestamp:  dto.timestamp  ? new Date(dto.timestamp) : null,
    });
    await this.repo.save(record);
    this.logsService.log(LogAction.ANALYTICS_TRACKED, { event: dto.event, product: dto.product ?? null, session_id: dto.session_id });
    return { success: true };
  }

  async findAll(): Promise<AnalyticsEvent[]> {
    return this.repo.find({ order: { created_at: 'DESC' }, take: 500 });
  }

  async getSummary(): Promise<{
    total_events: number;
    page_views: number;
    product_views: number;
    whatsapp_clicks: number;
    exit_popup: number;
  }> {
    const rows: { event: string; count: string }[] = await this.dataSource.query(`
      SELECT event, COUNT(*)::int AS count
      FROM analytics_events
      GROUP BY event
    `);

    const map: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      map[r.event] = Number(r.count);
      total += Number(r.count);
    }

    return {
      total_events:    total,
      page_views:      map['page_view']      ?? 0,
      product_views:   map['product_view']   ?? 0,
      whatsapp_clicks: map['whatsapp_click'] ?? 0,
      exit_popup:      map['exit_popup']     ?? 0,
    };
  }

  async getTopProducts(): Promise<{ product: string; total_views: number; whatsapp_clicks: number }[]> {
    const rows: { product: string; event: string; count: string }[] = await this.dataSource.query(`
      SELECT product, event, COUNT(*)::int AS count
      FROM analytics_events
      WHERE product IS NOT NULL
        AND product <> ''
        AND event IN ('product_view', 'whatsapp_click')
      GROUP BY product, event
      ORDER BY product
    `);

    const map: Record<string, { total_views: number; whatsapp_clicks: number }> = {};
    for (const r of rows) {
      if (!map[r.product]) map[r.product] = { total_views: 0, whatsapp_clicks: 0 };
      if (r.event === 'product_view')   map[r.product].total_views      += Number(r.count);
      if (r.event === 'whatsapp_click') map[r.product].whatsapp_clicks  += Number(r.count);
    }

    return Object.entries(map)
      .map(([product, stats]) => ({ product, ...stats }))
      .sort((a, b) => b.total_views - a.total_views)
      .slice(0, 10);
  }

  async getSourceBreakdown(): Promise<{ source: string; count: number }[]> {
    const rows: { source: string; count: string }[] = await this.dataSource.query(`
      SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS count
      FROM analytics_events
      GROUP BY COALESCE(source, 'unknown')
      ORDER BY count DESC
    `);

    return rows.map(r => ({ source: r.source, count: Number(r.count) }));
  }
}

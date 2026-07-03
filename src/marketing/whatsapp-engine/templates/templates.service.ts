import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { MarketingTemplate } from '../entities/marketing-template.entity';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    @InjectRepository(MarketingTemplate)
    private repo: Repository<MarketingTemplate>,
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  findAll(): Promise<MarketingTemplate[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<MarketingTemplate> {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Template ${id} not found`);
    return t;
  }

  create(dto: Partial<MarketingTemplate>): Promise<MarketingTemplate> {
    return this.repo.save(this.repo.create(dto));
  }

  async update(
    id: string,
    dto: Partial<MarketingTemplate>,
  ): Promise<MarketingTemplate> {
    await this.findOne(id);
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.repo.delete(id);
  }

  // Replace {{placeholder}} tokens; unknown tokens are left as-is
  interpolate(body: string, vars: Record<string, string>): string {
    return body.replace(
      /\{\{(\w+)\}\}/g,
      (_, key: string) => vars[key] ?? `{{${key}}}`,
    );
  }

  // Recompute performance_weight for each template based on reply rate from last 30 days.
  // weight = clamp(0.1, 0.5 + replyRate * 5, 3.0) where replyRate is 0.0–1.0
  async updatePerformanceWeights(): Promise<void> {
    type StatRow = { template_id: string; sent: string; replied: string };
    const stats: StatRow[] = await this.ds.query(`
      SELECT
        q.template_id,
        COUNT(l.id)                                         AS sent,
        COUNT(l.id) FILTER (WHERE l.status = 'replied')    AS replied
      FROM whatsapp_message_queue q
      JOIN whatsapp_message_logs l ON l.queue_id = q.id
      WHERE q.template_id IS NOT NULL
        AND l.sent_at >= NOW() - INTERVAL '30 days'
      GROUP BY q.template_id
    `);

    for (const row of stats) {
      const sent = parseInt(row.sent, 10);
      if (sent < 5) continue; // not enough data yet
      const replyRate = parseInt(row.replied, 10) / sent;
      const weight = Math.min(3.0, Math.max(0.1, 0.5 + replyRate * 5.0));
      await this.repo.update(row.template_id, {
        performance_weight: Math.round(weight * 100) / 100,
      });
    }

    this.logger.log(
      `[Templates] Updated performance weights for ${stats.length} template(s)`,
    );
  }
}

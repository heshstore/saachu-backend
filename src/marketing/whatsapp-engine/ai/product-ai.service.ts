import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class ProductAiService {
  private readonly logger = new Logger(ProductAiService.name);

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async recommendProducts(phone: string): Promise<number[]> {
    try {
      const rows: { id: number }[] = await this.ds.query(
        `SELECT id FROM items WHERE (is_active = true OR is_active IS NULL) ORDER BY RANDOM() LIMIT 5`,
      );
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  async matchAudienceToProduct(audienceId: string): Promise<number | null> {
    try {
      const rows: { id: number }[] = await this.ds.query(
        `SELECT id FROM items WHERE (is_active = true OR is_active IS NULL) ORDER BY RANDOM() LIMIT 1`,
      );
      return rows.length > 0 ? rows[0].id : null;
    } catch {
      return null;
    }
  }
}

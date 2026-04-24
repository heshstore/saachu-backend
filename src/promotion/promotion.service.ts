import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PromotionContact } from './entities/promotion-contact.entity';
import { PromotionCaptureDto } from './dto/promotion-capture.dto';

@Injectable()
export class PromotionService {
  constructor(
    @InjectRepository(PromotionContact)
    private readonly repo: Repository<PromotionContact>,
    private readonly dataSource: DataSource,
  ) {}

  private async ensureTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS promotion_contacts (
        id               SERIAL PRIMARY KEY,
        whatsapp_number  VARCHAR(15),
        email            VARCHAR(255),
        source           TEXT,
        page_url         TEXT,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_whatsapp
        ON promotion_contacts(whatsapp_number)
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_promo_email
        ON promotion_contacts(email)
    `);
  }

  async create(dto: PromotionCaptureDto): Promise<{ success: boolean; message: string; data: PromotionContact }> {
    await this.ensureTable();

    dto.whatsapp_number = dto.whatsapp_number || undefined;
    dto.email = dto.email || undefined;

    console.log('Promotion Capture:', dto);

    if (!dto.whatsapp_number && !dto.email) {
      throw new BadRequestException('At least one of whatsapp_number or email is required.');
    }

    // Deduplication: check whatsapp_number first, then email
    if (dto.whatsapp_number) {
      const existing = await this.repo.findOne({ where: { whatsapp_number: dto.whatsapp_number } });
      if (existing) {
        return { success: true, message: 'Already exists', data: existing };
      }
    }

    if (dto.email) {
      const existing = await this.repo.findOne({ where: { email: dto.email } });
      if (existing) {
        return { success: true, message: 'Already exists', data: existing };
      }
    }

    const record = this.repo.create({
      whatsapp_number: dto.whatsapp_number ?? null,
      email:           dto.email           ?? null,
      source:          dto.source,
      page_url:        dto.page_url,
    });

    const saved = await this.repo.save(record);
    return { success: true, message: 'Saved', data: saved };
  }
}

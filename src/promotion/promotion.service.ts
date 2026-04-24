import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromotionContact } from './entities/promotion-contact.entity';
import { PromotionCaptureDto } from './dto/promotion-capture.dto';

@Injectable()
export class PromotionService {
  constructor(
    @InjectRepository(PromotionContact)
    private readonly repo: Repository<PromotionContact>,
  ) {}

  async create(dto: PromotionCaptureDto): Promise<{ success: boolean; message: string; data: PromotionContact }> {
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

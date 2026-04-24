import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { TrackEventDto } from './dto/track-event.dto';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly repo: Repository<AnalyticsEvent>,
  ) {}

  async track(dto: TrackEventDto): Promise<{ success: boolean }> {
    const record = this.repo.create({
      session_id: dto.session_id,
      event:      dto.event,
      product:    dto.product ?? null,
      page_url:   dto.page_url,
    });
    await this.repo.save(record);
    return { success: true };
  }
}

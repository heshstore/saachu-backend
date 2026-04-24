import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { TrackEventDto } from './dto/track-event.dto';
import { Public } from '../auth/public.decorator';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post('track')
  @Public()
  @HttpCode(200)
  track(@Body() dto: TrackEventDto) {
    return this.analyticsService.track(dto);
  }
}

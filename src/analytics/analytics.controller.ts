import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { TrackEventDto } from './dto/track-event.dto';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post('track')
  @Public()
  @HttpCode(200)
  track(@Body() dto: TrackEventDto) {
    return this.analyticsService.track(dto);
  }

  @Get()
  @RequirePermission('crm.analytics.all')
  findAll() {
    return this.analyticsService.findAll();
  }

  @Get('summary')
  @RequirePermission('crm.analytics.team')
  getSummary() {
    return this.analyticsService.getSummary();
  }

  @Get('top-products')
  @RequirePermission('crm.analytics.team')
  getTopProducts() {
    return this.analyticsService.getTopProducts();
  }

  @Get('source-breakdown')
  @RequirePermission('crm.analytics.team')
  getSourceBreakdown() {
    return this.analyticsService.getSourceBreakdown();
  }
}

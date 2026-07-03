import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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

  // ── Phase 4: Operational KPI endpoints ─────────────────────────────────────

  @Get('kpis')
  @RequirePermission('order.view')
  getOperationalKpis() {
    return this.analyticsService.getOperationalKpis();
  }

  @Get('sales')
  @RequirePermission('quotation.view')
  getSalesAnalytics(@Query('days') days?: string) {
    return this.analyticsService.getSalesAnalytics(Number(days ?? 30));
  }

  @Get('production')
  @RequirePermission('production.view')
  getProductionAnalytics(@Query('days') days?: string) {
    return this.analyticsService.getProductionAnalytics(Number(days ?? 30));
  }

  @Get('notifications')
  @RequirePermission('order.view')
  getNotificationsSummary(@Req() req: any) {
    const userId: number | undefined =
      req.user?.userId ?? req.user?.sub ?? req.user?.id;
    return this.analyticsService.getNotificationsSummary(userId);
  }

  @Get('system-health')
  @RequirePermission('order.view')
  getSystemHealth() {
    return this.analyticsService.getSystemHealth();
  }

  @Get('activity-feed')
  @RequirePermission('order.view')
  getActivityFeed(@Query('limit') limit?: string) {
    return this.analyticsService.getActivityFeed(Number(limit ?? 20));
  }
}

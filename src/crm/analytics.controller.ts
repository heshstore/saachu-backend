import { Controller, Get, Param, ParseIntPipe, Query, Request } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('crm/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @RequirePermission('crm.analytics.team')
  getOverview(@Request() req) {
    return this.analyticsService.getOverview(req.user);
  }

  @Get('sources')
  @RequirePermission('crm.analytics.all')
  getSourceBreakdown(@Request() req) {
    return this.analyticsService.getSourceBreakdown(req.user);
  }

  @Get('my')
  @RequirePermission('crm.analytics.self')
  getMyStats(@Request() req) {
    return this.analyticsService.getMyStats(req.user);
  }

  @Get('leaderboard')
  @RequirePermission('crm.analytics.team')
  getLeaderboard(@Request() req) {
    return this.analyticsService.getLeaderboard(req.user);
  }

  @Get('performance/:userId')
  @RequirePermission('crm.analytics.self')
  getPerformance(@Param('userId', ParseIntPipe) userId: number, @Request() req) {
    return this.analyticsService.getPerformance(userId, req.user);
  }

  /** Leads grouped by context ("META – Lead Form", "SHOPIFY – WhatsApp Click", etc.) */
  @Get('contexts')
  @RequirePermission('crm.analytics.all')
  getContextBreakdown(@Request() req) {
    return this.analyticsService.getContextBreakdown(req.user);
  }

  /** Leads created per day. ?days=30 (default) up to 365. */
  @Get('daily')
  @RequirePermission('crm.analytics.team')
  getDateBreakdown(@Query('days') days: string, @Request() req) {
    return this.analyticsService.getDateBreakdown(parseInt(days) || 30, req.user);
  }

  @Get('telecaller/:id')
  @RequirePermission('crm.analytics.all')
  getTelecallerStats(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.analyticsService.getTelecallerStats(id, req.user);
  }

  @Get('response-speed')
  @RequirePermission('crm.analytics.team')
  getResponseSpeed(@Request() req) {
    return this.analyticsService.getResponseSpeed(req.user);
  }

  @Get('funnel')
  @RequirePermission('crm.analytics.team')
  getFunnel(@Request() req) {
    return this.analyticsService.getFunnel(req.user);
  }

  @Get('risk-signals')
  @RequirePermission('crm.analytics.team')
  getRiskSignals(@Request() req) {
    return this.analyticsService.getRiskSignals(req.user);
  }

  @Get('response-buckets')
  @RequirePermission('crm.analytics.team')
  getResponseBuckets(@Request() req) {
    return this.analyticsService.getResponseBuckets(req.user);
  }
}

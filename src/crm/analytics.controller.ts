import { Controller, Get, Param, ParseIntPipe, Request } from '@nestjs/common';
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

  @Get('telecaller/:id')
  @RequirePermission('crm.analytics.all')
  getTelecallerStats(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.analyticsService.getTelecallerStats(id, req.user);
  }
}

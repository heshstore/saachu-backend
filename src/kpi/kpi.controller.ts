import { Controller, Get, Query, Req } from '@nestjs/common';
import { KpiEngineService } from './kpi-engine.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('kpi')
export class KpiController {
  constructor(private readonly kpi: KpiEngineService) {}

  @Get('summary')
  @RequirePermission('staff.view')
  getSummary(@Query('days') days?: string) {
    return this.kpi.getSummary(Number(days ?? 30));
  }

  @Get('me')
  getMyKpi(@Req() req: any, @Query('days') days?: string) {
    const userId: number = req.user?.userId ?? req.user?.sub ?? req.user?.id;
    return this.kpi.getUserSummary(userId, Number(days ?? 30));
  }

  @Get('leaderboard')
  @RequirePermission('staff.view')
  getLeaderboard(
    @Query('metric') metric = 'leads_handled',
    @Query('days') days?: string,
  ) {
    return this.kpi.getLeaderboard(metric, Number(days ?? 30));
  }

  @Get('snapshots')
  @RequirePermission('staff.view')
  getSnapshots(
    @Query('module') module = 'SALES',
    @Query('metric') metric = 'leads_total',
    @Query('days') days?: string,
  ) {
    return this.kpi.getHistoricalSnapshots(module, metric, Number(days ?? 30));
  }
}

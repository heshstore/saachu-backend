import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KpiEngineService } from './kpi-engine.service';

@UseGuards(JwtAuthGuard)
@Controller('kpi')
export class KpiController {
  constructor(private readonly kpi: KpiEngineService) {}

  @Get('summary')
  getSummary(@Query('days') days?: string) {
    return this.kpi.getSummary(Number(days ?? 30));
  }

  @Get('me')
  getMyKpi(@Req() req: any, @Query('days') days?: string) {
    const userId: number = req.user?.userId ?? req.user?.sub ?? req.user?.id;
    return this.kpi.getUserSummary(userId, Number(days ?? 30));
  }

  @Get('leaderboard')
  getLeaderboard(
    @Query('metric') metric = 'leads_handled',
    @Query('days') days?: string,
  ) {
    return this.kpi.getLeaderboard(metric, Number(days ?? 30));
  }

  @Get('snapshots')
  getSnapshots(
    @Query('module') module = 'SALES',
    @Query('metric') metric = 'leads_total',
    @Query('days') days?: string,
  ) {
    return this.kpi.getHistoricalSnapshots(module, metric, Number(days ?? 30));
  }
}

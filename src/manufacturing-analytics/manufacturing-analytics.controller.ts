import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ManufacturingAnalyticsService } from './manufacturing-analytics.service';
import { CostingSnapshotService } from './costing-snapshot.service';

@Controller('manufacturing-analytics')
export class ManufacturingAnalyticsController {
  constructor(
    private readonly analytics: ManufacturingAnalyticsService,
    private readonly costingSnapshots: CostingSnapshotService,
  ) {}

  @Get('intel')
  @RequirePermission('production.view')
  getIntel() {
    return this.analytics.getIntelSummary();
  }

  @Get('overview')
  @RequirePermission('production.view')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.getOverview(from, to);
  }

  @Get('departments/performance')
  @RequirePermission('production.view')
  deptPerformance() {
    return this.analytics.getDepartmentPerformance();
  }

  @Get('delays')
  @RequirePermission('production.view')
  delays(@Query('limit') limit?: string) {
    return this.analytics.getDelayInsights(limit ? +limit : 8);
  }

  @Get('wastage/leaders')
  @RequirePermission('production.view')
  wastageLeaders(@Query('limit') limit?: string) {
    return this.analytics.getWastageLeaders(limit ? +limit : 10);
  }

  @Get('materials')
  @RequirePermission('production.view')
  materials(@Query('limit') limit?: string) {
    return this.analytics.getMaterialInsights(limit ? +limit : 12);
  }

  @Get('profitability/orders')
  @RequirePermission('production.view')
  profitability(@Query('limit') limit?: string) {
    return this.analytics.getOrderProfitability(limit ? +limit : 40);
  }

  @Get('snapshots/order/:orderId')
  @RequirePermission('production.view')
  snapshotsByOrder(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.analytics.listSnapshotsForOrder(orderId);
  }

  @Get('snapshots/job/:jobId')
  @RequirePermission('production.view')
  snapshotByJob(@Param('jobId', ParseIntPipe) jobId: number) {
    return this.analytics.getSnapshotByJob(jobId);
  }

  @Post('snapshots/job/:jobId')
  @RequirePermission('production.view')
  ensureSnapshot(@Param('jobId', ParseIntPipe) jobId: number) {
    return this.costingSnapshots.ensureSnapshotForJob(jobId);
  }

  @Post('snapshots/backfill')
  @RequirePermission('production.update')
  backfill(@Query('limit') limit?: string) {
    const lim = limit ? +limit : 100;
    return this.costingSnapshots.backfillMissingSnapshots(lim);
  }

  @Get('department-costs')
  @RequirePermission('production.view')
  listDeptCosts() {
    return this.analytics.listDepartmentCosts();
  }

  @Put('department-costs/:departmentId')
  @RequirePermission('production.update')
  putDeptCost(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Body()
    body: {
      costPerHour?: number;
      manpowerRate?: number;
      overheadRate?: number;
      active?: boolean;
    },
  ) {
    return this.analytics.upsertDepartmentCost(departmentId, body);
  }
}

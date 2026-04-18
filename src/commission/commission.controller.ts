import { Controller, Get, Query } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('commission')
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  @Get('summary')
  @RequirePermission('staff.view')
  getSummary(@Query('month') month: string) {
    return this.commissionService.getMonthlySummary(month);
  }

  @Get('salesman')
  @RequirePermission('staff.view')
  getSalesmanReport(@Query('month') month: string) {
    return this.commissionService.getSalesmanReport(month);
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('commission')
export class CommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  // ✅ Monthly summary
  @Get('summary')
  getSummary(@Query('month') month: string) {
    return this.commissionService.getMonthlySummary(month);
  }

  // ✅ Salesman report
  @Get('salesman')
  getSalesmanReport(@Query('month') month: string) {
    return this.commissionService.getSalesmanReport(month);
  }
}

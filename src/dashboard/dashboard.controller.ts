import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { RequirePermission }  from '../auth/require-permission.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  @RequirePermission('order.view')
  getSummary() {
    return this.service.getSummary();
  }

  @Get('top-items')
  @RequirePermission('order.view')
  getTopItems() {
    return this.service.getTopItems();
  }
}

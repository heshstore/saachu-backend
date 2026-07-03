import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { perfMonitorInstance } from './perf-monitor.service';

@Controller('perf-monitor')
export class PerfMonitorController {
  @Get('snapshot')
  @RequirePermission('rbac.manage')
  getSnapshot() {
    return perfMonitorInstance.getSnapshot();
  }
}

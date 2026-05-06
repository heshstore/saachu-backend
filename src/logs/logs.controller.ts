import { Controller, Get, Query } from '@nestjs/common';
import { LogsService } from './logs.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  @RequirePermission('crm.analytics.all')
  findAll(@Query('limit') limit?: string, @Query('action') action?: string) {
    const parsed = limit ? parseInt(limit, 10) : 200;
    if (action) return this.logsService.findByAction(action, parsed);
    return this.logsService.findAll(parsed);
  }
}

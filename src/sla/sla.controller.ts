import { Controller, Get, Query, Request } from '@nestjs/common';
import { SlaEngineService } from './sla-engine.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('sla')
export class SlaController {
  constructor(private readonly slaEngine: SlaEngineService) {}

  /** Admin view: all SLA events with optional filters */
  @Get()
  @RequirePermission('staff.view')
  listAll(
    @Query('status') status?: string,
    @Query('module') module?: string,
    @Query('priority') priority?: string,
    @Query('page') page?: string,
  ) {
    return this.slaEngine.listAll({
      status,
      module,
      priority,
      page: page ? Math.max(1, parseInt(page, 10)) : 1,
    });
  }

  /** Per-user: SLA events assigned to the caller */
  @Get('my')
  listMine(@Request() req) {
    return this.slaEngine.listForUser(req.user.id);
  }

  /** Counts by status + module (non-resolved only) */
  @Get('stats')
  @RequirePermission('staff.view')
  getStats() {
    return this.slaEngine.getStats();
  }
}

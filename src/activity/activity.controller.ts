import { Controller, Get, Param, Query, Request, ParseIntPipe } from '@nestjs/common';
import { ActivityService } from './activity.service';

@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  /** Global activity feed with optional filters */
  @Get()
  getGlobal(
    @Query('module')      module?: string,
    @Query('entity_type') entity_type?: string,
    @Query('source')      source?: string,
    @Query('severity')    severity?: string,
    @Query('user_id')     user_id?: string,
    @Query('from')        from?: string,
    @Query('to')          to?: string,
    @Query('page')        page?: string,
  ) {
    return this.activityService.getGlobalActivity({
      module,
      entity_type,
      source,
      severity,
      user_id:  user_id  ? parseInt(user_id, 10)  : undefined,
      from,
      to,
      page:     page     ? Math.max(1, parseInt(page, 10)) : 1,
    });
  }

  /** Timeline for a specific entity (e.g. lead:42, job:7) */
  @Get('entity/:type/:id')
  getEntityTimeline(
    @Param('type')            entityType: string,
    @Param('id', ParseIntPipe) entityId:  number,
    @Query('page')            page?: string,
  ) {
    return this.activityService.getEntityTimeline(
      entityType,
      entityId,
      page ? Math.max(1, parseInt(page, 10)) : 1,
    );
  }

  /** Activity log for a specific user */
  @Get('user/:id')
  getUserActivity(
    @Param('id', ParseIntPipe) userId: number,
    @Query('page')             page?: string,
  ) {
    return this.activityService.getUserActivity(
      userId,
      page ? Math.max(1, parseInt(page, 10)) : 1,
    );
  }

  /** My own activity */
  @Get('me')
  getMyActivity(@Request() req, @Query('page') page?: string) {
    return this.activityService.getUserActivity(
      req.user.id,
      page ? Math.max(1, parseInt(page, 10)) : 1,
    );
  }
}

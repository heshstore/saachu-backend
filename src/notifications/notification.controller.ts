import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Request,
} from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifService: NotificationService) {}

  // ── Panel: original endpoint (unchanged behavior) ────────────────────────────

  @Get()
  getForUser(
    @Request() req,
    @Query('category') category?: string,
    @Query('priority') priority?: string,
    @Query('unread') unread?: string,
    @Query('page') page?: string,
  ) {
    // If any filter/page param is provided, serve the center view (paginated)
    if (category || priority || unread || page) {
      return this.notifService.getNotificationsForCenter(req.user.id, {
        category,
        priority,
        unread: unread === 'true',
        page: page ? Math.max(1, parseInt(page, 10)) : 1,
      });
    }
    // Default: panel list (50 items, active only — existing behavior)
    return this.notifService.getUserNotifications(req.user.id);
  }

  @Get('count')
  async getUnreadCount(@Request() req) {
    const { total, byCategory } = await this.notifService.getCountByCategory(
      req.user.id,
    );
    return { count: total, byCategory };
  }

  @Get('next-action')
  getNextBestAction(@Request() req) {
    return this.notifService.getNextBestAction(req.user.id);
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  @Patch('read-all')
  markAllRead(@Request() req) {
    return this.notifService.markAllRead(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Request() req) {
    return this.notifService.markAsRead(id, req.user.id);
  }

  // Soft-hide: removes from center without deleting the DB row
  @Delete(':id')
  hideNotification(@Param('id') id: string, @Request() req) {
    return this.notifService.hideNotification(id, req.user.id);
  }
}

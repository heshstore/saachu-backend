import { Controller, Get, Patch, Param, Request } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifService: NotificationService) {}

  @Get()
  getForUser(@Request() req) {
    return this.notifService.getUserNotifications(req.user.id);
  }

  @Get('count')
  getUnreadCount(@Request() req) {
    return this.notifService.getUnreadCount(req.user.id).then(count => ({ count }));
  }

  @Get('next-action')
  getNextBestAction(@Request() req) {
    return this.notifService.getNextBestAction(req.user.id);
  }

  @Patch('read-all')
  markAllRead(@Request() req) {
    return this.notifService.markAllRead(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Request() req) {
    return this.notifService.markAsRead(id, req.user.id);
  }
}

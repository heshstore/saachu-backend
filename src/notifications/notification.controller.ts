import { Controller, Get, Patch, Param, ParseIntPipe, Request } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifService: NotificationService) {}

  @Get()
  getForUser(@Request() req) {
    return this.notifService.getForUser(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.notifService.markRead(id, req.user.id);
  }

  @Patch('read-all')
  markAllRead(@Request() req) {
    return this.notifService.markAllRead(req.user.id);
  }
}

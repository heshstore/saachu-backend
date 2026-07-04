import { Controller, Get, Request } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifService: NotificationService) {}

  @Get('next-action')
  getNextBestAction(@Request() req) {
    return this.notifService.getNextBestAction(req.user.id);
  }
}

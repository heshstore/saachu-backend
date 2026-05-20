import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
} from '@nestjs/common';
import { InboxService } from './inbox.service';

@Controller('marketing/whatsapp-engine/inbox')
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  findAll() {
    return this.inboxService.findAll();
  }

  @Get('phone/:phone')
  findByPhone(@Param('phone') phone: string) {
    return this.inboxService.findByPhone(phone);
  }

  @Patch(':id/lead')
  markLeadCreated(@Param('id') id: string, @Body() body: { leadId: number }) {
    return this.inboxService.markLeadCreated(id, body.leadId);
  }
}

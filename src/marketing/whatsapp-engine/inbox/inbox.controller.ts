import {
  Controller,
  Get,
  Post,
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

  // Full conversation thread: merged INBOUND + OUTBOUND sorted by timestamp
  @Get('conversation/:phone')
  getConversation(@Param('phone') phone: string) {
    return this.inboxService.getConversation(decodeURIComponent(phone));
  }

  @Patch(':id/lead')
  markLeadCreated(@Param('id') id: string, @Body() body: { leadId: number }) {
    return this.inboxService.markLeadCreated(id, body.leadId);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.inboxService.markRead(id);
  }

  // Send a reply to the customer via the same marketing number that received their message
  @Post(':id/reply')
  sendReply(@Param('id') id: string, @Body() body: { message: string }) {
    return this.inboxService.sendReply(id, body.message);
  }
}

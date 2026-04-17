import {
  Controller, Get, Post, Body, Param, Query, Request, Sse, MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly waService: WhatsAppService) {}

  @Sse('sse')
  @RequirePermission('whatsapp.manage')
  qrStream(): Observable<MessageEvent> {
    return this.waService.getQrObservable() as Observable<MessageEvent>;
  }

  @Get('status')
  @RequirePermission('whatsapp.manage')
  getStatus() {
    return this.waService.getSessionStatus();
  }

  @Post('send')
  @RequirePermission('lead.edit')
  send(@Body() body: { chatId: string; message: string }, @Request() req) {
    return this.waService.sendMessage(body.chatId, body.message, req.user?.id);
  }

  @Get('chat/:chatId/messages')
  @RequirePermission('lead.view')
  getChatMessages(@Param('chatId') chatId: string, @Query('leadId') leadId?: string) {
    return this.waService.getChatMessages(chatId, leadId ? +leadId : undefined);
  }
}

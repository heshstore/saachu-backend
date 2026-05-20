import {
  Controller, Get, Post, Body, Param, Query, Request, HttpCode,
} from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly waService: WhatsAppService) {}

  @Get('status')
  @RequirePermission('whatsapp.manage')
  getStatus() {
    return this.waService.getSessionStatus();
  }

  @Post('disconnect')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async disconnect() {
    await this.waService.disconnectAndReset();
    return { ok: true };
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

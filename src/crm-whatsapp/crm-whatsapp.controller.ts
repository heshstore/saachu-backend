import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Request,
  HttpCode,
} from '@nestjs/common';
import { CrmWhatsAppService } from './crm-whatsapp.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('whatsapp')
export class CrmWhatsAppController {
  constructor(private readonly waService: CrmWhatsAppService) {}

  @Get('status')
  @RequirePermission('whatsapp.manage')
  getStatus() {
    return this.waService.getFullStatus();
  }

  @Get('qr')
  @RequirePermission('whatsapp.manage')
  getQr() {
    return this.waService.getQrData();
  }

  @Post('connect')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async connect() {
    await this.waService.connect();
    return { ok: true };
  }

  @Post('disconnect')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async disconnect() {
    await this.waService.disconnect();
    return { ok: true };
  }

  @Post('reset')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async reset() {
    await this.waService.reset();
    return { ok: true };
  }

  // ── Used by lead detail send button ──────────────────────────────────────────

  @Post('send')
  @RequirePermission('lead.edit')
  send(@Body() body: { chatId: string; message: string }, @Request() req) {
    return this.waService.sendMessage(body.chatId, body.message, req.user?.id);
  }

  @Get('chat/:chatId/messages')
  @RequirePermission('lead.view')
  getChatMessages(
    @Param('chatId') chatId: string,
    @Query('leadId') leadId?: string,
  ) {
    return this.waService.getChatMessages(chatId, leadId ? +leadId : undefined);
  }
}

import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('whatsapp/admin')
export class WhatsAppAdminController {
  constructor(private readonly waService: WhatsAppService) {}

  @Get('status')
  @RequirePermission('whatsapp.manage')
  getStatus() {
    return this.waService.getAdminStatus();
  }

  @Get('qr')
  @RequirePermission('whatsapp.manage')
  getQr() {
    return this.waService.getQrData();
  }

  @Post('restart')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async restart() {
    await this.waService.safeRestart();
    return { success: true };
  }

  /** Full session wipe + fresh QR — use when pairing handshake keeps stalling. */
  @Post('reset')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async reset() {
    await this.waService.resetWhatsAppSession();
    return { success: true };
  }

  /** Manual reconnect after QR retry limit — resets pause state without wiping auth. */
  @Post('reconnect')
  @HttpCode(200)
  @RequirePermission('whatsapp.manage')
  async reconnect() {
    await this.waService.manualReconnect();
    return { success: true };
  }
}

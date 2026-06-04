import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Sse,
  MessageEvent,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { NumbersService } from './numbers.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';

@Controller('marketing/whatsapp-engine/numbers')
export class NumbersController {
  private readonly logger = new Logger(NumbersController.name);

  constructor(
    private readonly numbersService: NumbersService,
    private readonly marketingWa: MarketingWhatsAppService,
  ) {}

  @Get()
  async findAll() {
    const numbers = await this.numbersService.findAll();
    return numbers.map((n) => ({
      ...n,
      ...this.marketingWa.getNumberWaStatus(n.id),
    }));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.numbersService.findOne(id);
  }

  @Post()
  create(@Body() dto: Partial<WhatsappNumber>) {
    return this.numbersService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<WhatsappNumber>) {
    return this.numbersService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.numbersService.remove(id);
  }

  @Post('reset-daily')
  resetDailyCounts() {
    return this.numbersService.resetDailyCounts();
  }

  @Get(':id/health-trend')
  getHealthTrend(@Param('id') id: string) {
    return this.numbersService.getHealthTrend(id);
  }

  // ── Connection management ────────────────────────────────────────────────────

  /** Live WA session state for this number (connection status, QR active, last ready). */
  @Get(':id/status')
  getWaStatus(@Param('id') id: string) {
    return this.marketingWa.getNumberWaStatus(id);
  }

  /** Current QR image (polling-friendly). Returns { active, qr, generatedAt }. */
  @Get(':id/qr')
  getQr(@Param('id') id: string) {
    return this.marketingWa.getQrData(id);
  }

  /** SSE stream — pushes qr / state_change / ready / error events in real time. */
  @Sse(':id/sse')
  qrStream(@Param('id') id: string): Observable<MessageEvent> {
    return this.marketingWa.getQrObservable(id) as Observable<MessageEvent>;
  }

  /** Start the WA client for this number (shows QR if no saved session). */
  @Post(':id/connect')
  @HttpCode(200)
  async connect(@Param('id') id: string) {
    this.logger.warn(`[CONNECT_ENDPOINT_HIT] numberId=${id} ts=${new Date().toISOString()}`);
    await this.numbersService.findOne(id); // 404 guard
    await this.marketingWa.connectNumber(id, true /* isManual — user initiated */)
    this.logger.warn(`[CONNECT_ENDPOINT_DONE] numberId=${id} ts=${new Date().toISOString()}`);
    return { ok: true, message: 'Connect initiated — scan QR at /numbers/:id/qr' };
  }

  /** Gracefully disconnect and destroy the WA client for this number. */
  @Post(':id/disconnect')
  @HttpCode(200)
  async disconnect(@Param('id') id: string) {
    await this.marketingWa.disconnectNumber(id);
    return { ok: true };
  }

  /** Wipe LocalAuth session and re-pair from scratch (generates fresh QR). */
  @Post(':id/reset')
  @HttpCode(200)
  async reset(@Param('id') id: string) {
    await this.numbersService.findOne(id); // 404 guard
    await this.marketingWa.resetNumber(id);
    return { ok: true, message: 'Session wiped — scan new QR at /numbers/:id/qr' };
  }

  /**
   * HARD RESET — destroys client, removes from memory map, wipes full LocalAuth session dir.
   * Use for corrupted sessions (lock files, bad state, repeated initialize() failures).
   * After this, call /connect to generate a fresh QR.
   */
  @Post(':id/hard-reset')
  @HttpCode(200)
  async hardReset(@Param('id') id: string) {
    await this.numbersService.findOne(id); // 404 guard
    return this.marketingWa.hardResetSession(id);
  }

  /**
   * RECOVERY — resets wa_state to null for ALL numbers in DB.
   * Use when the backend logged "Startup — connecting N" but QR never appeared.
   * After calling this, manually disconnect+connect each number via the UI.
   */
  @Post('recovery/reset-states')
  @HttpCode(200)
  recoveryResetStates() {
    return this.marketingWa.resetAllConnectionStates();
  }
}

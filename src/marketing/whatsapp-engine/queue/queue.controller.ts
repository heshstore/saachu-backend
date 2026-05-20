import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { QueueService } from './queue.service';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';

@Controller('marketing/whatsapp-engine/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('pending')
  findPending(@Query('limit') limit?: string) {
    return this.queueService.findPending(limit ? parseInt(limit, 10) : 20);
  }

  @Get('campaign/:campaignId')
  findByCampaign(
    @Param('campaignId') campaignId: string,
    @Query('limit') limit?: string,
  ) {
    return this.queueService.findByCampaign(campaignId, limit ? parseInt(limit, 10) : 200);
  }

  @Post('enqueue')
  enqueue(@Body() dto: Partial<WhatsappMessageQueue>) {
    return this.queueService.enqueue(dto);
  }

  @Patch(':id/skip')
  skip(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.queueService.markSkipped(id, body.reason ?? 'Manually skipped');
  }
}

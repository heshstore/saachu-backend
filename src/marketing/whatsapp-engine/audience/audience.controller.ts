import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
} from '@nestjs/common';
import { AudienceService } from './audience.service';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { AutonomousEngineService } from '../engine/autonomous-engine.service';

@Controller('marketing/whatsapp-engine/audience')
export class AudienceController {
  constructor(
    private readonly audienceService: AudienceService,
    private readonly autonomousEngine: AutonomousEngineService,
  ) {}

  @Get()
  findAll() {
    return this.audienceService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.audienceService.findOne(id);
  }

  @Post()
  create(@Body() dto: Partial<MarketingAudience>) {
    return this.audienceService.create(dto);
  }

  @Post('bulk')
  async bulkUpsert(@Body() body: { rows: Partial<MarketingAudience>[] }) {
    const result = await this.audienceService.bulkUpsert(body.rows ?? []);
    // Rule 3: immediately fill remaining daily capacity with newly eligible contacts.
    // Fire-and-forget — import response returns instantly.
    this.autonomousEngine.fillRemainingCapacity().catch(() => {});
    return result;
  }

  /** Check which phones already exist — returns existing records for conflict resolution UI. */
  @Post('check-conflicts')
  checkConflicts(@Body() body: { phones: string[] }) {
    return this.audienceService.checkConflicts(body.phones ?? []);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<MarketingAudience>) {
    return this.audienceService.update(id, dto);
  }

  @Patch(':id/optout')
  markOptOut(@Param('id') id: string) {
    return this.audienceService.markOptOut(id);
  }

  @Patch(':id/test-contact')
  markAsTestContact(
    @Param('id') id: string,
    @Body() body: { is_test: boolean },
  ) {
    return this.audienceService.markAsTestContact(id, body.is_test ?? true);
  }

  @Get('filter/test-contacts')
  findTestContacts() {
    return this.audienceService.findTestContacts();
  }

  @Get('stats/health')
  getHealthStats() {
    return this.audienceService.getHealthStats();
  }

  @Get(':id/history')
  getContactHistory(@Param('id') id: string) {
    return this.audienceService.getContactHistory(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.audienceService.remove(id);
  }
}

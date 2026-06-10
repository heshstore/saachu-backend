import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
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
  create(@Body() body: Partial<MarketingAudience> & { confirm_production?: boolean }) {
    const { confirm_production, ...dto } = body;
    return this.audienceService.create(dto, {
      confirmProduction: confirm_production === true,
    });
  }

  @Post('bulk')
  async bulkUpsert(@Body() body: {
    rows: Partial<MarketingAudience>[];
    confirm_production?: boolean;
  }) {
    const result = await this.audienceService.bulkUpsert(
      body.rows ?? [],
      { confirmProduction: body.confirm_production === true },
    );
    this.autonomousEngine.fillRemainingCapacity().catch(() => {});
    return result;
  }

  @Post('check-conflicts')
  checkConflicts(@Body() body: { phones: string[] }) {
    return this.audienceService.checkConflicts(body.phones ?? []);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Partial<MarketingAudience> & { confirm_production?: boolean },
  ) {
    const { confirm_production, ...dto } = body;
    return this.audienceService.update(id, dto, {
      confirmProduction: confirm_production === true,
    });
  }

  @Patch(':id/optout')
  markOptOut(
    @Param('id') id: string,
    @Body() body: { confirm_production?: boolean },
  ) {
    return this.audienceService.markOptOut(id, {
      confirmProduction: body?.confirm_production === true,
    });
  }

  @Patch(':id/test-contact')
  markAsTestContact(
    @Param('id') id: string,
    @Body() body: { is_test: boolean; confirm_production?: boolean },
  ) {
    return this.audienceService.markAsTestContact(id, body.is_test ?? true, {
      confirmProduction: body?.confirm_production === true,
    });
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
  remove(
    @Param('id') id: string,
    @Query('confirm_production') confirmProduction?: string,
  ) {
    return this.audienceService.remove(id, {
      confirmProduction: confirmProduction === 'true',
    });
  }
}

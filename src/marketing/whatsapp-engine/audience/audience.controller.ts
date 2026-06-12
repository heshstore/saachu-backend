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
import { randomUUID } from 'crypto';
import { AudienceService } from './audience.service';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { AutonomousEngineService } from '../engine/autonomous-engine.service';
import { SkipRecoveryService } from '../skip-recovery/skip-recovery.service';

@Controller('marketing/whatsapp-engine/audience')
export class AudienceController {
  constructor(
    private readonly audienceService: AudienceService,
    private readonly autonomousEngine: AutonomousEngineService,
    private readonly skipRecovery: SkipRecoveryService,
  ) {}

  @Get()
  findAll() {
    return this.audienceService.findAll();
  }

  /** Paginated, filterable, searchable contact list — replaces full findAll for UI. */
  @Get('search')
  search(
    @Query('q')             q?: string,
    @Query('city')          city?: string,
    @Query('business_type') business_type?: string,
    @Query('status')        status?: string,
    @Query('page')          page?: string,
    @Query('limit')         limit?: string,
  ) {
    return this.audienceService.search({
      q, city, business_type, status,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  /** Distinct cities and business types for filter dropdowns. */
  @Get('filter-options')
  getFilterOptions() {
    return this.audienceService.getFilterOptions();
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
    // Fire-and-forget: persist skip records for Skip Recovery Dashboard.
    // Non-blocking — import response is not delayed by this.
    if (result.skip_reasons?.length) {
      this.skipRecovery
        .persistSkips(result.skip_reasons, body.rows ?? [], randomUUID())
        .catch(() => {});
    }
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

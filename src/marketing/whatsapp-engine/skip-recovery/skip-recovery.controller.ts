import {
  Controller, Get, Post, Param, Query, Body, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SkipRecoveryService } from './skip-recovery.service';

@Controller('marketing/whatsapp-engine/skip-recovery')
export class SkipRecoveryController {
  constructor(private readonly svc: SkipRecoveryService) {}

  /** Summary counts — powers dashboard cards */
  @Get('summary')
  summary() {
    return this.svc.summary();
  }

  /** Paginated, searchable list of all skip records */
  @Get('search')
  search(
    @Query('q')           q?: string,
    @Query('reason_code') reason_code?: string,
    @Query('recovered')   recovered?: string,
    @Query('page')        page?: string,
    @Query('limit')       limit?: string,
  ) {
    return this.svc.search({
      q,
      reason_code,
      recovered,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  /** CSV export — query params: reason_code, recoverable_only */
  @Get('export')
  async exportCsv(
    @Query('reason_code')      reason_code?: string,
    @Query('recoverable_only') recoverableOnly?: string,
    @Res() res?: Response,
  ) {
    const csv = await this.svc.exportCsv({
      reason_code,
      recoverable_only: recoverableOnly === 'true',
    });
    if (res) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="skipped_contacts.csv"');
      res.send(csv);
    } else {
      return csv;
    }
  }

  /** Recover a single skipped contact into the promotional DB */
  @Post(':id/recover')
  recover(
    @Param('id') id: string,
    @Body() body: {
      phone?: string;
      email?: string;
      company?: string;
      name?: string;
      city?: string;
      business_type?: string;
      confirm_production?: boolean;
    },
  ) {
    return this.svc.recover(id, body);
  }

  /** Full record — powers the edit modal pre-fill */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }
}

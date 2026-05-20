import { Controller, Get, Param, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('marketing/whatsapp-engine/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // /engine/dashboard must come before /dashboard to avoid route shadowing
  @Get('engine/dashboard')
  getEngineDashboardStats() {
    return this.analyticsService.getEngineDashboardStats();
  }

  @Get('dashboard')
  getDashboardStats() {
    return this.analyticsService.getDashboardStats();
  }

  @Get('template-performance')
  getTemplatePerformance() {
    return this.analyticsService.getTemplatePerformance();
  }

  @Get('daily-report')
  getDailyReport() {
    return this.analyticsService.getDailyReport();
  }

  @Get('conversion-funnel')
  getConversionFunnel(@Query('days') days?: string) {
    return this.analyticsService.getConversionFunnel(days ? parseInt(days, 10) : 7);
  }

  @Get('logs')
  getLogs(
    @Query('status') status?: string,
    @Query('phone') phone?: string,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.analyticsService.findLogs({
      status,
      phone,
      campaignId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('campaigns/:id')
  getCampaignStats(@Param('id') id: string) {
    return this.analyticsService.getCampaignStats(id);
  }

  @Get('numbers/:id')
  getNumberStats(@Param('id') id: string) {
    return this.analyticsService.getNumberStats(id);
  }
}

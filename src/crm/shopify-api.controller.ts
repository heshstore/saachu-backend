import { Controller, Get, Post, Body, HttpCode, Logger, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { LeadService } from './lead.service';

export class ShopifyLeadDto {
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() message?: string;
  @IsOptional() @IsString() product?: string;
  @IsOptional() @IsString() product_url?: string;
  @IsOptional() @IsString() page_url?: string;
  @IsOptional() @IsString() lead_type?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsString() timestamp?: string;
}

@Controller('api/leads')
export class ShopifyApiController {
  private readonly logger = new Logger(ShopifyApiController.name);

  constructor(private readonly leadService: LeadService) {}

  @Get()
  @Public()
  getLeads(@Query('status') status?: string, @Query('source') source?: string) {
    return this.leadService.findAll({ status, source }, { role: 'Admin', id: 0 });
  }

  @Post('shopify')
  @Public()
  @HttpCode(200)
  async createShopifyLead(@Body() body: ShopifyLeadDto) {
    this.logger.log(`Shopify lead received: ${JSON.stringify(body)}`);
    const result = await this.leadService.createFromShopifyClick(body);
    return { success: result.ok, leadId: result.leadId };
  }
}

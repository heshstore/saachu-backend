import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { LeadService } from './lead.service';

export class ShopifyLeadDto {
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() action?: string;
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

  @Post('shopify')
  @Public()
  @HttpCode(200)
  async createShopifyLead(@Body() body: ShopifyLeadDto) {
    this.logger.log(`Shopify lead received: ${JSON.stringify(body)}`);
    const result = await this.leadService.createFromShopifyClick(body);
    return { success: result.ok, leadId: result.leadId };
  }
}

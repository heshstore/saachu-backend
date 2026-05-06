import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { PromotionService } from './promotion.service';
import { PromotionCaptureDto } from './dto/promotion-capture.dto';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller()
export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Post('promotion-capture')
  @Public()
  @HttpCode(200)
  create(@Body() dto: PromotionCaptureDto) {
    return this.promotionService.create(dto);
  }

  @Get('promotion-contacts')
  @RequirePermission('crm.analytics.all')
  findAll() {
    return this.promotionService.findAll();
  }
}

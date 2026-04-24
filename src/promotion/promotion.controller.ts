import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PromotionService } from './promotion.service';
import { PromotionCaptureDto } from './dto/promotion-capture.dto';
import { Public } from '../auth/public.decorator';

@Controller()
export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Post('promotion-capture')
  @Public()
  @HttpCode(200)
  create(@Body() dto: PromotionCaptureDto) {
    return this.promotionService.create(dto);
  }
}

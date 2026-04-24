import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromotionContact } from './entities/promotion-contact.entity';
import { PromotionService } from './promotion.service';
import { PromotionController } from './promotion.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PromotionContact])],
  controllers: [PromotionController],
  providers: [PromotionService],
})
export class PromotionModule {}

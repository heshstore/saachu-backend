import { Module } from '@nestjs/common';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Product])], // ✅ THIS IS MISSING
  controllers: [ShopifyController],
  providers: [ShopifyService],
})
export class ShopifyModule {}
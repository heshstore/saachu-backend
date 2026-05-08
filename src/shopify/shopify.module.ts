import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopifyService } from './shopify.service';
import { ShopifyController } from './shopify.controller';
import { Product } from '../products/entities/product.entity';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Product, ShopifyCatalogItem])],
  controllers: [ShopifyController],
  providers: [ShopifyService],
})
export class ShopifyModule {}
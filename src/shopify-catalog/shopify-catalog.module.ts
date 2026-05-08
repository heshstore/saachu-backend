import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopifyCatalogItem } from './entities/shopify-catalog-item.entity';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { ShopifyCatalogController } from './shopify-catalog.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ShopifyCatalogItem])],
  controllers: [ShopifyCatalogController],
  providers: [ShopifyCatalogService],
  exports: [ShopifyCatalogService],
})
export class ShopifyCatalogModule {}

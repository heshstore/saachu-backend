import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShopifyCatalogItem } from '../shopify-catalog/entities/shopify-catalog-item.entity';
import { ServiceItem } from '../service-items/entities/service-item.entity';
import { ItemsService } from './items.service';
import { ItemsController } from './items.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ShopifyCatalogItem, ServiceItem])],
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
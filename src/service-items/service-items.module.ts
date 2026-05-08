import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceItem } from './entities/service-item.entity';
import { ServiceItemsService } from './service-items.service';
import { ServiceItemsController } from './service-items.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceItem])],
  controllers: [ServiceItemsController],
  providers: [ServiceItemsService],
  exports: [ServiceItemsService],
})
export class ServiceItemsModule {}

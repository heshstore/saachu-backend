import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Commission } from './entities/commission.entity';
import { CommissionService } from './commission.service';
import { CommissionController } from './commission.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Commission])],
  providers: [CommissionService],
  controllers: [CommissionController],
})
export class CommissionModule {}
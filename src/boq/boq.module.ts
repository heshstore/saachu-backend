import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ManufacturingBoq } from './entities/manufacturing-boq.entity';
import { ManufacturingBoqItem } from './entities/manufacturing-boq-item.entity';
import { BoqService } from './boq.service';
import { BoqController } from './boq.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ManufacturingBoq, ManufacturingBoqItem])],
  controllers: [BoqController],
  providers: [BoqService],
  exports: [BoqService],
})
export class BoqModule {}

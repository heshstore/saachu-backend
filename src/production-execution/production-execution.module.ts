import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionExecutionJob } from './entities/production-execution-job.entity';
import { ProductionJobStage } from './entities/production-job-stage.entity';
import { ProductionMaterialReservation } from './entities/production-material-reservation.entity';
import { InventoryTransaction } from '../inventory/entities/inventory-transaction.entity';
import { ProductionExecutionService } from './production-execution.service';
import { ProductionExecutionController } from './production-execution.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProductionExecutionJob,
      ProductionJobStage,
      ProductionMaterialReservation,
      InventoryTransaction,
    ]),
  ],
  controllers: [ProductionExecutionController],
  providers: [ProductionExecutionService],
  exports: [ProductionExecutionService],
})
export class ProductionExecutionModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepartmentCostMaster } from './entities/department-cost-master.entity';
import { ProductionCostSnapshot } from './entities/production-cost-snapshot.entity';
import { ManufacturingAnalyticsService } from './manufacturing-analytics.service';
import { CostingSnapshotService } from './costing-snapshot.service';
import { ManufacturingAnalyticsController } from './manufacturing-analytics.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([DepartmentCostMaster, ProductionCostSnapshot]),
  ],
  controllers: [ManufacturingAnalyticsController],
  providers:   [ManufacturingAnalyticsService, CostingSnapshotService],
  exports:     [ManufacturingAnalyticsService, CostingSnapshotService],
})
export class ManufacturingAnalyticsModule {}

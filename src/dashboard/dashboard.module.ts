import { Module }              from '@nestjs/common';
import { DashboardService }    from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { ManufacturingAnalyticsModule } from '../manufacturing-analytics/manufacturing-analytics.module';
import { FinanceOpsModule } from '../finance-ops/finance-ops.module';

// DataSource is provided globally by TypeOrmModule.forRoot() in AppModule —
// no forFeature() import needed here since we only use raw SQL.
// ManufacturingAnalyticsModule supplies read-only intel for the summary strip.
@Module({
  imports:     [ManufacturingAnalyticsModule, FinanceOpsModule],
  controllers: [DashboardController],
  providers:   [DashboardService],
})
export class DashboardModule {}

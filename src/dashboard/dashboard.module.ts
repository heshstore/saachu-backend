import { Module }              from '@nestjs/common';
import { DashboardService }    from './dashboard.service';
import { DashboardController } from './dashboard.controller';

// DataSource is provided globally by TypeOrmModule.forRoot() in AppModule —
// no forFeature() import needed here since we only use raw SQL.
@Module({
  controllers: [DashboardController],
  providers:   [DashboardService],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KpiSnapshot } from './entities/kpi-snapshot.entity';
import { KpiEngineService } from './kpi-engine.service';
import { KpiController } from './kpi.controller';
import { NotificationsModule } from '../notifications/notification.module';

@Module({
  imports: [TypeOrmModule.forFeature([KpiSnapshot]), NotificationsModule],
  controllers: [KpiController],
  providers: [KpiEngineService],
  exports: [KpiEngineService],
})
export class KpiModule {}

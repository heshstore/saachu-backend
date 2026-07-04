import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationEngineService } from './notification-engine.service';
import { ProductionJob } from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProductionJob, User])],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationEngineService],
  exports: [NotificationService],
})
export class NotificationsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './notification.entity';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';
import { NotificationEngineService } from './notification-engine.service';
import { ProductionJob } from '../orders/entities/production-job.entity';
import { User } from '../users/entities/user.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, ProductionJob, User]),
    WhatsappModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationEngineService, NotificationGateway],
  exports: [NotificationService],
})
export class NotificationsModule {}

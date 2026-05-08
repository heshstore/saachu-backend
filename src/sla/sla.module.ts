import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SlaEvent } from './entities/sla-event.entity';
import { SlaEngineService } from './sla-engine.service';
import { SlaController } from './sla.controller';
import { NotificationsModule } from '../notifications/notification.module';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SlaEvent, User]),
    NotificationsModule,
  ],
  controllers: [SlaController],
  providers: [SlaEngineService],
  exports: [SlaEngineService],
})
export class SlaModule {}

import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Log } from './entities/log.entity';
import { AuditLog } from './entities/audit-log.entity';
import { LogsService } from './logs.service';
import { AuditService } from './audit.service';
import { LogsController } from './logs.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Log, AuditLog])],
  controllers: [LogsController],
  providers: [LogsService, AuditService],
  exports: [LogsService, AuditService],
})
export class LogsModule {}

import { Module } from '@nestjs/common';
import { WorkforceOpsService } from './workforce-ops.service';
import { WorkforceOpsController } from './workforce-ops.controller';

@Module({
  controllers: [WorkforceOpsController],
  providers: [WorkforceOpsService],
  exports: [WorkforceOpsService],
})
export class WorkforceOpsModule {}

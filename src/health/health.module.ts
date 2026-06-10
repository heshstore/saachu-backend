import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { EnvironmentController } from './environment.controller';

@Module({
  controllers: [HealthController, EnvironmentController],
})
export class HealthModule {}

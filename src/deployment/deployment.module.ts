import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeploymentVersion } from './deployment-version.entity';
import { DeploymentVersionsService } from './deployment-versions.service';
import { DeploymentVersionsController } from './deployment-versions.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DeploymentVersion])],
  controllers: [DeploymentVersionsController],
  providers: [DeploymentVersionsService],
})
export class DeploymentModule {}

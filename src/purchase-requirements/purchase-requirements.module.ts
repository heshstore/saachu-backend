import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseRequirement } from './entities/purchase-requirement.entity';
import { PurchaseRequirementsService } from './purchase-requirements.service';
import { PurchaseRequirementsController } from './purchase-requirements.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PurchaseRequirement])],
  controllers: [PurchaseRequirementsController],
  providers: [PurchaseRequirementsService],
  exports: [PurchaseRequirementsService],
})
export class PurchaseRequirementsModule {}

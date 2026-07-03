import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AfterSalesService } from './after-sales.service';
import { AfterSalesController } from './after-sales.controller';
import { ServiceTicket } from './entities/service-ticket.entity';
import { ServiceTicketUpdate } from './entities/service-ticket-update.entity';
import { AmcContract } from './entities/amc-contract.entity';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServiceTicket,
      ServiceTicketUpdate,
      AmcContract,
      TechnicianProfile,
    ]),
    InventoryModule,
  ],
  controllers: [AfterSalesController],
  providers: [AfterSalesService],
  exports: [AfterSalesService],
})
export class AfterSalesModule {}

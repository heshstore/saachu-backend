import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { FinanceOpsService } from './finance-ops.service';
import { FinanceOpsController } from './finance-ops.controller';
import { FinanceOpsListener } from './finance-ops.listener';

@Module({
  imports: [
    OrdersModule,
  ],
  controllers: [FinanceOpsController],
  providers: [FinanceOpsService, FinanceOpsListener],
  exports: [FinanceOpsService],
})
export class FinanceOpsModule {}

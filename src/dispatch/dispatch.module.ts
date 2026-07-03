import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Dispatch } from './entities/dispatch.entity';
import { DispatchOrder } from './entities/dispatch-order.entity';
import { DispatchOrderItem } from './entities/dispatch-order-item.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { InventoryTransaction } from '../inventory/entities/inventory-transaction.entity';
import { DispatchService } from './dispatch.service';
import { DispatchOrdersService } from './dispatch-orders.service';
import { DispatchController } from './dispatch.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Dispatch,
      DispatchOrder,
      DispatchOrderItem,
      Order,
      OrderItem,
      InventoryTransaction,
    ]),
  ],
  controllers: [DispatchController],
  providers: [DispatchService, DispatchOrdersService],
  exports: [DispatchService, DispatchOrdersService],
})
export class DispatchModule {}

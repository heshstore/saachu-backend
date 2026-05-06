import { Module }           from '@nestjs/common';
import { TypeOrmModule }    from '@nestjs/typeorm';
import { Dispatch }         from './entities/dispatch.entity';
import { Order }            from '../orders/entities/order.entity';
import { DispatchService }  from './dispatch.service';
import { DispatchController } from './dispatch.controller';

@Module({
  imports:     [TypeOrmModule.forFeature([Dispatch, Order])],
  controllers: [DispatchController],
  providers:   [DispatchService],
  exports:     [DispatchService],
})
export class DispatchModule {}

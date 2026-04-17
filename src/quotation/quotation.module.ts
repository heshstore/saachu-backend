import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuotationController } from './quotation.controller';
import { QuotationService } from './quotation.service';
import { Quotation } from './quotation.entity';
import { QuotationItem } from './quotation-item.entity';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Quotation, QuotationItem]),
    forwardRef(() => OrdersModule),
  ],
  controllers: [QuotationController],
  providers: [QuotationService],
  exports: [QuotationService],
})
export class QuotationModule {}

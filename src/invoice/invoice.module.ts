import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Invoice } from './entities/invoice.entity';
import { InvoiceService } from './invoice.service';
import { InvoiceController } from './invoice.controller';
import { Order } from '../orders/entities/order.entity';
import { TransactionalEmailModule } from '../email-transactional/transactional-email.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice, Order]),
    TransactionalEmailModule,
  ],
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}

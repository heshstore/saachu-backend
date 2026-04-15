import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrdersModule } from './orders/orders.module';
import { InvoiceModule } from './invoice/invoice.module';
import { Order } from './orders/entities/order.entity';
import { OrderItem } from './orders/entities/order-item.entity';
import { Invoice } from './invoice/entities/invoice.entity';
import { Commission } from './commission/entities/commission.entity';
import { User } from './users/entities/user.entity';
import { CommissionModule } from './commission/commission.module';
import { Product } from './products/entities/product.entity';
import { ShopifyModule } from './shopify/shopify.module';
import { CustomersModule } from './customers/customers.module';
import { ItemsModule } from './items/items.module';
import { CitiesModule } from './cities/cities.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { QuotationModule } from './quotation/quotation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [Order, OrderItem, Invoice, Commission, User, Product],
      autoLoadEntities: true,
      synchronize: false,
      ssl: false,
    }),

    AuthModule,
    UsersModule,
    OrdersModule,
    InvoiceModule,
    CommissionModule,
    ShopifyModule,
    CustomersModule,
    ItemsModule,
    CitiesModule,
    QuotationModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}

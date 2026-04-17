import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';

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
import { PermissionGuard } from './auth/permission.guard';
import { QuotationModule } from './quotation/quotation.module';
import { SharedModule } from './shared/shared.module';
import { RbacModule } from './rbac/rbac.module';
import { CrmModule } from './crm/crm.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { NotificationsModule } from './notifications/notification.module';

const databaseUrl = process.env.DATABASE_URL || '';
const useDatabaseSsl =
  /neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(databaseUrl) ||
  process.env.DATABASE_SSL === 'true';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [Order, OrderItem, Invoice, Commission, User, Product],
      autoLoadEntities: true,
      synchronize: false,
      ssl: useDatabaseSsl ? { rejectUnauthorized: false } : false,
    }),

    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    SharedModule,
    AuthModule,
    RbacModule,
    UsersModule,
    OrdersModule,
    InvoiceModule,
    CommissionModule,
    ShopifyModule,
    CustomersModule,
    ItemsModule,
    CitiesModule,
    QuotationModule,
    CrmModule,
    WhatsappModule,
    NotificationsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
})
export class AppModule {}

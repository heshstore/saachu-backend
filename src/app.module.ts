import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

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
import { PromotionModule } from './promotion/promotion.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { LogsModule } from './logs/logs.module';
import { DispatchModule }   from './dispatch/dispatch.module';
import { DashboardModule }  from './dashboard/dashboard.module';

const databaseUrl = process.env.DATABASE_URL || '';
const useDatabaseSsl =
  /neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(databaseUrl) ||
  process.env.DATABASE_SSL === 'true';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Global default: 200 req/min per IP. Specific routes override via @Throttle().
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),

    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [Order, OrderItem, Invoice, Commission, User, Product],
      autoLoadEntities: true,
      synchronize: false,
      ssl: useDatabaseSsl ? { rejectUnauthorized: false } : false,
      // Explicit pool config — pg defaults to max:10 which saturates under pessimistic locks at scale.
      extra: {
        max:                    Number(process.env.DB_POOL_MAX)  || 25,
        min:                    Number(process.env.DB_POOL_MIN)  || 2,
        idleTimeoutMillis:      30_000,   // release idle connections after 30s
        connectionTimeoutMillis: 5_000,   // fail fast if pool is exhausted (better than hanging)
      },
    }),

    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: false, delimiter: '.', global: true }),
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
    PromotionModule,
    AnalyticsModule,
    LogsModule,
    DispatchModule,
    DashboardModule,
  ],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}

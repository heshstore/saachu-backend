import { Module, Logger } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { sanitizeDatabaseUrl, buildSslOption, redactDatabaseUrl } from './utils/db-url.util';

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
import { ShopifyCatalogModule } from './shopify-catalog/shopify-catalog.module';
import { ServiceItemsModule } from './service-items/service-items.module';
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
import { HealthModule }     from './health/health.module';
import { SlaModule }        from './sla/sla.module';
import { ActivityModule }   from './activity/activity.module';
import { KpiModule }        from './kpi/kpi.module';
import { EventsModule }     from './events/events.module';
import { DepartmentsModule } from './departments/departments.module';
import { BoqModule }         from './boq/boq.module';
import { InventoryModule }             from './inventory/inventory.module';
import { PurchaseRequirementsModule }   from './purchase-requirements/purchase-requirements.module';
import { ProductionExecutionModule }    from './production-execution/production-execution.module';
import { VendorsModule }                 from './vendors/vendors.module';
import { PurchaseOrdersModule }          from './purchase-orders/purchase-orders.module';
import { ManufacturingAnalyticsModule } from './manufacturing-analytics/manufacturing-analytics.module';
import { AfterSalesModule } from './after-sales/after-sales.module';
import { FinanceOpsModule } from './finance-ops/finance-ops.module';
import { WorkforceOpsModule } from './workforce-ops/workforce-ops.module';
import { AppShutdownService } from './common/app-shutdown.service';

const _rawDbUrl      = process.env.DATABASE_URL || '';
const databaseUrl    = sanitizeDatabaseUrl(_rawDbUrl);
const useDatabaseSsl = buildSslOption(databaseUrl) !== false || process.env.DATABASE_SSL === 'true';

// Startup log — confirms channel_binding is gone before TypeORM connects
new Logger('AppModule').log(
  `DB URL (sanitized): ${redactDatabaseUrl(databaseUrl) || '(not set)'}`,
);

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Global default: 200 req/min per IP. Specific routes override via @Throttle().
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),

    TypeOrmModule.forRoot({
      type: 'postgres',
      url: databaseUrl,           // sanitized — channel_binding stripped
      entities: [Order, OrderItem, Invoice, Commission, User, Product],
      autoLoadEntities: true,
      synchronize: false,
      ssl: useDatabaseSsl ? { rejectUnauthorized: false } : false,
      extra: {
        max:                          Number(process.env.DB_POOL_MAX) || 10,
        min:                          0,
        idleTimeoutMillis:            30_000,
        connectionTimeoutMillis:      15_000,
        keepAlive:                    true,
        keepAliveInitialDelayMillis:  10_000,
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
    ShopifyCatalogModule,
    ServiceItemsModule,
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
    HealthModule,
    SlaModule,
    ActivityModule,
    KpiModule,
    EventsModule,
    DepartmentsModule,
    BoqModule,
    InventoryModule,
    PurchaseRequirementsModule,
    ProductionExecutionModule,
    VendorsModule,
    PurchaseOrdersModule,
    ManufacturingAnalyticsModule,
    AfterSalesModule,
    FinanceOpsModule,
    WorkforceOpsModule,
  ],
  providers: [
    AppShutdownService,
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}

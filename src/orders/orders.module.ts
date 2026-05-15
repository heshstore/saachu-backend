import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { PaymentService } from './payment.service';
import { OrderExplosionService } from './order-explosion.service';

import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Payment } from './entities/payment.entity';
import { ProductionJob } from './entities/production-job.entity';
import { ProductionAlert } from './entities/production-alert.entity';
import { ProductionEfficiency } from './entities/production-efficiency.entity';
import { OrderMaterialRequirement } from './entities/order-material-requirement.entity';
import { DepartmentWorkload } from './entities/department-workload.entity';
import { Customer } from '../customers/entities/customer.entity';
import { User } from '../users/entities/user.entity';
import { ProductionService } from './production.service';
import { ProductionController } from './production.controller';
import { PaymentsController } from './payments.controller';
import { AccountsController } from './accounts.controller';
import { CrmWhatsappService } from './crm-whatsapp.service';
import { ProductionCommandService } from './production-command.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order, OrderItem, Payment, ProductionJob, ProductionAlert, ProductionEfficiency,
      OrderMaterialRequirement, DepartmentWorkload,
      Customer, User,
    ]),
    WhatsappModule,
  ],
  controllers: [OrdersController, ProductionController, PaymentsController, AccountsController],
  providers: [OrdersService, PaymentService, ProductionService, CrmWhatsappService, ProductionCommandService, OrderExplosionService],
  exports: [OrdersService, PaymentService, ProductionService, CrmWhatsappService, OrderExplosionService],
})
export class OrdersModule {}

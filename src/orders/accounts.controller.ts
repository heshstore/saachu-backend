import { Controller, Get } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get('pending-summary')
  @RequirePermission('payment.view')
  getPendingSummary() {
    return this.paymentService.getPendingSummary();
  }
}

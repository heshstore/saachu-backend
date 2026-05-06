import { Controller, Post, Get, Body, Param, ParseIntPipe, Req } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentService: PaymentService) {}

  /** Orders with an outstanding balance, live-computed from the payments table. */
  @Get('outstanding')
  @RequirePermission('payment.view')
  getOutstanding() {
    return this.paymentService.getOutstanding();
  }

  /** Full payment history for a single order. */
  @Get('order/:orderId')
  @RequirePermission('payment.view')
  getPayments(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.paymentService.getPayments(orderId);
  }

  /** Record a new payment. Body: { order_id, amount, payment_mode, payment_reference?, notes? } */
  @Post('create')
  @RequirePermission('payment.create')
  createPayment(@Body() body: any, @Req() req: any) {
    const { order_id, ...dto } = body;
    return this.paymentService.addPayment(Number(order_id), dto, req.user?.id);
  }
}

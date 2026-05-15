import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req,
} from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { FinanceOpsService } from './finance-ops.service';
import { FinancePaymentMode, FinancePaymentType } from './entities/payment-entry.entity';

@Controller('finance-ops')
export class FinanceOpsController {
  constructor(private readonly finance: FinanceOpsService) {}

  @Get('dashboard')
  @RequirePermission('payment.view')
  dashboard() {
    return this.finance.getDashboardSummary();
  }

  @Get('warnings')
  @RequirePermission('payment.view')
  warnings() {
    return this.finance.getWarnings();
  }

  @Get('receivables')
  @RequirePermission('payment.view')
  receivables(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.finance.listReceivables({
      status: status || undefined,
      customerId: customerId ? Number(customerId) : undefined,
    });
  }

  @Get('payables')
  @RequirePermission('payment.view')
  payables(
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
  ) {
    return this.finance.listPayables({
      status: status || undefined,
      vendorId: vendorId ? Number(vendorId) : undefined,
    });
  }

  @Get('payment-entries')
  @RequirePermission('payment.view')
  paymentEntries(
    @Query('paymentType') paymentType?: FinancePaymentType,
    @Query('customerId') customerId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.finance.listPaymentEntries({
      paymentType: paymentType || undefined,
      customerId: customerId ? Number(customerId) : undefined,
      vendorId: vendorId ? Number(vendorId) : undefined,
      from: from || undefined,
      to: to || undefined,
    });
  }

  @Get('customers/:id/summary')
  @RequirePermission('customer.view')
  customerSummary(@Param('id', ParseIntPipe) id: number) {
    return this.finance.getCustomerFinanceSummary(id);
  }

  @Get('vendors/:id/summary')
  @RequirePermission('inventory.view')
  vendorSummary(@Param('id', ParseIntPipe) id: number) {
    return this.finance.getVendorFinanceSummary(id);
  }

  @Post('customer-receipts')
  @RequirePermission('payment.create')
  customerReceipt(@Body() body: {
    orderId: number;
    amount: number;
    paymentMode: FinancePaymentMode;
    paymentReference?: string;
    remarks?: string;
    idempotencyKey?: string;
  }, @Req() req: { user?: { id?: number } }) {
    return this.finance.addCustomerReceipt(body, req.user?.id);
  }

  @Post('vendor-payments')
  @RequirePermission('payment.create')
  vendorPayment(@Body() body: {
    purchaseOrderId: number;
    amount: number;
    paymentMode: FinancePaymentMode;
    paymentDate?: string;
    remarks?: string;
  }, @Req() req: { user?: { id?: number } }) {
    return this.finance.addVendorPayment(body, req.user?.id);
  }

  @Post('admin/resync-open')
  @RequirePermission('payment.create')
  resyncOpen() {
    return this.finance.resyncAllOpen();
  }
}

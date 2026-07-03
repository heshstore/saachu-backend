import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FinanceOpsService } from './finance-ops.service';

@Injectable()
export class FinanceOpsListener {
  constructor(private readonly finance: FinanceOpsService) {}

  @OnEvent('order.approved')
  async onOrderApproved(payload: { orderId: number }) {
    if (payload?.orderId)
      await this.finance.syncCustomerReceivable(payload.orderId);
  }

  @OnEvent('order.updated')
  async onOrderUpdated(payload: { orderId: number }) {
    if (payload?.orderId)
      await this.finance.syncCustomerReceivable(payload.orderId);
  }

  @OnEvent('payment.received')
  async onPaymentReceived(payload: {
    orderId?: number;
    order_id?: number;
    paymentId?: number | null;
  }) {
    const orderId = payload?.orderId ?? payload?.order_id;
    if (!orderId) return;
    if (payload.paymentId) {
      await this.finance.ensurePaymentEntryForLinkedPayment(payload.paymentId);
    }
    await this.finance.syncCustomerReceivable(orderId);
  }

  @OnEvent('dispatch.created')
  async onDispatchCreated(payload: { order_id?: number }) {
    if (payload?.order_id)
      await this.finance.syncCustomerReceivable(payload.order_id);
  }

  @OnEvent('dispatch.delivered')
  async onDispatchDelivered(payload: { order_id?: number }) {
    if (payload?.order_id)
      await this.finance.syncCustomerReceivable(payload.order_id);
  }

  @OnEvent('purchase_order.updated')
  async onPurchaseOrderUpdated(payload: { purchaseOrderId: number }) {
    if (payload?.purchaseOrderId)
      await this.finance.syncVendorPayable(payload.purchaseOrderId);
  }
}

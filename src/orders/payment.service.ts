import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository }       from 'typeorm';
import { EventEmitter2 }    from '@nestjs/event-emitter';
import { Payment, PaymentMode } from './entities/payment.entity';
import { Order }                from './entities/order.entity';

export interface AddPaymentDto {
  amount:             number;
  payment_mode:       PaymentMode;
  payment_reference?: string;
  idempotency_key?:   string;
  notes?:             string;
}

export interface PaymentSummary {
  order_id:       number;
  total_amount:   number;
  paid_amount:    number;
  pending_amount: number;
  is_fully_paid:  boolean;
  payments:       Payment[];
}

const VALID_MODES: PaymentMode[] = ['cash', 'upi', 'bank'];

@Injectable()
export class PaymentService {
  constructor(
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,

    @InjectRepository(Order)
    private orderRepo: Repository<Order>,

    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Records a payment against an order inside a transaction.
   *
   * The order row is locked for the duration of the transaction so that
   * concurrent calls cannot both pass the overpayment check and then
   * both commit — only one succeeds, the other sees the updated paid sum.
   */
  async addPayment(orderId: number, dto: AddPaymentDto, userId?: number): Promise<PaymentSummary> {
    if (dto.amount <= 0)
      throw new BadRequestException('Payment amount must be greater than zero');

    if (!VALID_MODES.includes(dto.payment_mode))
      throw new BadRequestException(`Invalid payment_mode. Allowed: ${VALID_MODES.join(', ')}`);

    if (['upi', 'bank'].includes(dto.payment_mode) && !dto.payment_reference?.trim())
      throw new BadRequestException(
        `Payment reference (UTR/transaction ID) is required for ${dto.payment_mode.toUpperCase()} payments`,
      );

    // Idempotency: if the caller retries with the same key, return the existing result.
    if (dto.idempotency_key) {
      const existing = await this.paymentRepo.findOne({ where: { idempotency_key: dto.idempotency_key } });
      if (existing) return this.getSummary(existing.order_id);
    }

    await this.paymentRepo.manager.transaction(async (tx) => {
      // Lock order row — prevents two simultaneous payments from both
      // passing the overpayment check and both committing.
      const order = await tx.findOne(Order, {
        where: { id: orderId },
        lock:  { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');

      // Compute current paid total from the payments table (not cached column)
      const [{ total }] = await tx.query<{ total: string }[]>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = $1`,
        [orderId],
      );
      const currentPaid = Number(total);
      const pending     = Math.max(0, Number(order.total_amount) - currentPaid);

      if (pending === 0)
        throw new BadRequestException('Order is already fully paid');

      if (dto.amount > pending)
        throw new BadRequestException(
          `Amount ₹${dto.amount.toFixed(2)} exceeds outstanding balance ₹${pending.toFixed(2)}`,
        );

      // Duplicate reference guard (DB unique constraint is the real guard; this gives a cleaner error)
      if (dto.payment_reference) {
        const dup = await tx.findOne(Payment, {
          where: { payment_reference: dto.payment_reference },
        });
        if (dup)
          throw new BadRequestException(
            `Duplicate payment: reference "${dto.payment_reference}" already recorded on payment #${dup.id}`,
          );
      }

      const payment = tx.create(Payment, {
        order_id:          orderId,
        amount:            dto.amount,
        payment_mode:      dto.payment_mode,
        payment_reference: dto.payment_reference ?? null,
        idempotency_key:   dto.idempotency_key   ?? null,
        notes:             dto.notes             ?? null,
        created_by:        userId               ?? null,
      });
      await tx.save(payment);

      // Sync cached columns on the order row
      const newPaid    = currentPaid + dto.amount;
      const newPending = Math.max(0, Number(order.total_amount) - newPaid);
      await tx.update(Order, { id: orderId }, {
        paid_amount:    newPaid,
        pending_amount: newPending,
      } as any);
    });

    this.eventEmitter.emit('payment.received', { orderId, amount: dto.amount, createdBy: userId ?? null });

    return this.getSummary(orderId);
  }

  /** Reads the current payment state for an order. Cached columns are kept
   *  accurate by the transaction in addPayment — no re-sync needed here. */
  async getSummary(orderId: number): Promise<PaymentSummary> {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    const payments = await this.paymentRepo.find({
      where: { order_id: orderId },
      order: { created_at: 'ASC' },
    });

    const paid    = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const total   = Number(order.total_amount);
    const pending = Math.max(0, total - paid);

    return {
      order_id:       orderId,
      total_amount:   total,
      paid_amount:    paid,
      pending_amount: pending,
      is_fully_paid:  pending === 0,
      payments,
    };
  }

  getPayments(orderId: number): Promise<Payment[]> {
    return this.paymentRepo.find({
      where: { order_id: orderId },
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Orders that still have an outstanding balance, computed live from the
   * payments table so it's accurate even if cached columns drift.
   */
  getOutstanding(): Promise<any[]> {
    return this.orderRepo.manager.query(`
      SELECT
        o.id,
        o.order_no,
        o.customer_name,
        o.customer_phone,
        o.total_amount::numeric                                    AS total_amount,
        COALESCE(SUM(p.amount), 0)::numeric                       AS paid_amount,
        GREATEST(o.total_amount - COALESCE(SUM(p.amount), 0), 0)::numeric
                                                                   AS pending_amount
      FROM   orders   o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE  o.total_amount > 0
      GROUP  BY o.id, o.order_no, o.customer_name, o.customer_phone, o.total_amount
      HAVING GREATEST(o.total_amount - COALESCE(SUM(p.amount), 0), 0) > 0
      ORDER  BY pending_amount DESC
    `);
  }
}

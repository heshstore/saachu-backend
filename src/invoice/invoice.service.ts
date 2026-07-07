import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IsNull } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { Invoice } from './entities/invoice.entity';
import { appConfig } from '../config/config';
import {
  ORDER_SALESMAN_JOINS,
  ORDER_SALESMAN_SELECT,
  enrichRowsWithCustomerEmail,
  enrichRowsWithEmailCount,
  enrichRowsWithActionCounts,
} from '../shared/ownership.util';

@Injectable()
export class InvoiceService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
  ) {}

  // ── Invoice/Estimate number generator — Hs-00001 / E-00001 format ────────────
  // Uses the document_no_counter table (same mechanism as quotation/order — see
  // generateQuotationNo/generateOrderNo) so the increment participates in the
  // caller's transaction instead of being permanently burned on a rolled-back
  // create. Invoice and Estimate are separate rows ('invoice' / 'estimate'),
  // so creating one never advances the other's number — previously both types
  // shared a single COUNT(*)+1 over the same table, which was neither
  // independent (an estimate advanced the next invoice's number) nor
  // concurrency-safe (two simultaneous creates could read the same count).
  // Split invoices (production/trading billing company) draw from these same
  // two counters rather than their own PINV-/TINV- sequences, so "invoice" and
  // "estimate" remain single, unified sequences regardless of billing company.
  private async generateDocNo(
    manager: EntityManager,
    type: 'TALLY' | 'ESTIMATE',
  ): Promise<string> {
    const name = type === 'ESTIMATE' ? 'estimate' : 'invoice';
    const prefix = type === 'ESTIMATE' ? 'E-' : 'Hs-';
    // TypeORM's query() special-cases UPDATE/DELETE: it returns [rows,
    // affectedCount] instead of rows directly (unlike a plain SELECT) — so
    // the RETURNING row is result[0][0], not result[0].
    const result = await manager.query(
      `UPDATE document_no_counter SET value = value + 1 WHERE name = $1 RETURNING value`,
      [name],
    );
    const next = Number(result[0][0].value);
    return `${prefix}${String(next).padStart(5, '0')}`;
  }

  async createFromOrder(orderId: number, type: 'TALLY' | 'ESTIMATE' = 'TALLY') {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['items'],
    });

    if (!order) throw new NotFoundException('Order not found');

    // Credit limit check — fetch customer directly from customer table
    let customer: any = null;
    if (order.customer_id) {
      const rows = await this.orderRepository.manager.query<any[]>(
        `SELECT id, "isWholesaler", "creditLimit", state FROM customer WHERE id = $1 LIMIT 1`,
        [order.customer_id],
      );
      customer = rows[0] ?? null;
    }

    // A Wholesaler must have a credit limit assigned before any invoice is
    // raised against them — same gate enforced at quotation/order creation,
    // re-checked here in case it was removed after the order was placed.
    if (customer?.isWholesaler && !(Number(customer.creditLimit) > 0)) {
      throw new BadRequestException(
        'This customer is a Wholesaler with no Credit Limit assigned. Set a credit limit for this customer before raising this invoice.',
      );
    }

    if (customer?.creditLimit && Number(customer.creditLimit) > 0) {
      const outstandingInvoices = await this.invoiceRepository
        .createQueryBuilder('inv')
        .innerJoin(Order, 'ord', 'ord.id = inv.order_id')
        .where('ord.customer_id = :cid', { cid: customer.id })
        .andWhere('inv.status != :paid', { paid: 'PAID' })
        .getMany();

      const outstanding = outstandingInvoices.reduce(
        (sum, inv) => sum + Number(inv.total_amount || 0),
        0,
      );

      if (outstanding >= Number(customer.creditLimit)) {
        return {
          blocked: true,
          message: `Credit limit of ₹${customer.creditLimit} exceeded. Outstanding: ₹${outstanding}`,
          outstanding,
          credit_limit: customer.creditLimit,
        };
      }
    }

    // GST split: CGST+SGST if same state, else IGST.
    // Sum each item's own gst_amount (already correctly computed per its actual
    // rate and Extra/Inclusive tax mode at order-creation time) rather than
    // assuming a flat 18% of the order total — items can be 5/12/18/28%.
    const total = Number(order.total_amount);
    const gstAmount = (order.items || []).reduce(
      (sum, it) => sum + Number(it.gst_amount || 0),
      0,
    );

    const customerState = (customer?.state || '').toLowerCase();
    const isSameState = customerState === appConfig.companyState.toLowerCase();

    const cgst = isSameState ? gstAmount / 2 : 0;
    const sgst = isSameState ? gstAmount / 2 : 0;
    const igst = isSameState ? 0 : gstAmount;

    const saved = await this.invoiceRepository.manager.transaction(
      async (manager) => {
        // Generated inside the same transaction as the save — if anything
        // below fails, the counter increment rolls back with it instead of
        // being permanently burned (see generateDocNo).
        const invoice_no = await this.generateDocNo(manager, type);

        const invoice = manager.getRepository(Invoice).create({
          order_id: orderId,
          invoice_no,
          type,
          total_amount: total,
          status: 'PENDING',
          gst_type: isSameState ? 'CGST_SGST' : 'IGST',
          cgst,
          sgst,
          igst,
          payment_terms: order.payment_terms,
          credit_days: order.credit_days,
          is_wholesaler: order.is_wholesaler,
        });

        return manager.save(invoice);
      },
    );

    return saved;
  }

  async findAll() {
    return this.invoiceRepository.find({ order: { id: 'DESC' } });
  }

  async findOne(id: number) {
    const rows = await this.invoiceRepository.manager.query<any[]>(
      `SELECT inv.*, o.order_no, o.status AS order_status,
              o.customer_id, o.customer_name, o.customer_phone,
              o.billing_address, o.shipping_address, o.gst_number,
              o.is_tax_inclusive,
              ${ORDER_SALESMAN_SELECT}
       FROM invoice inv
       JOIN orders o ON o.id = inv.order_id
       ${ORDER_SALESMAN_JOINS}
       WHERE inv.id = $1
       LIMIT 1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Invoice not found');
    await enrichRowsWithCustomerEmail(
      this.invoiceRepository.manager.connection,
      rows,
    );
    await enrichRowsWithEmailCount(
      this.invoiceRepository.manager.connection,
      rows,
      'invoice',
    );
    await enrichRowsWithActionCounts(
      this.invoiceRepository.manager.connection,
      rows,
      'invoice',
    );
    return rows[0];
  }

  create(body: any) {
    return body;
  }

  applySplit(id: number, body: any) {
    return { id, body };
  }

  // ── Split billing extension ──────────────────────────────────────────────────
  // New methods added inside the existing service class.
  // All existing methods above are completely untouched.

  async createSplitFromOrder(
    orderId: number,
    billingCompany: 'PRODUCTION' | 'TRADING',
    type: 'TALLY' | 'ESTIMATE' = 'TALLY',
  ): Promise<Invoice> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Guard: refuse to create a split invoice if a legacy (single) invoice already exists
    const legacy = await this.invoiceRepository.findOne({
      where: { order_id: orderId, billing_company: IsNull() },
    });
    if (legacy) {
      throw new ConflictException(
        `Order ${orderId} already has a legacy invoice. Use the standard invoice endpoint or void the legacy invoice first.`,
      );
    }

    // Idempotency — return existing split invoice if already created
    const existing = await this.invoiceRepository.findOne({
      where: { order_id: orderId, billing_company: billingCompany },
    });
    if (existing) return existing;

    // Filter items to this billing company only
    const items = (order.items || []).filter(
      (i) => i.billing_category === billingCompany,
    );
    if (items.length === 0) {
      throw new BadRequestException(
        `No items classified as ${billingCompany} on order ${orderId}. ` +
          `Assign billing_category to order items before generating a split invoice.`,
      );
    }

    // Total from filtered items only (not order.total_amount which aggregates both)
    const total = items.reduce((s, i) => s + Number(i.amount), 0);

    // Customer state for GST split — same logic as createFromOrder()
    let customer: any = null;
    if (order.customer_id) {
      const rows = await this.orderRepository.manager.query<any[]>(
        `SELECT id, "isWholesaler", "creditLimit", state FROM customer WHERE id = $1 LIMIT 1`,
        [order.customer_id],
      );
      customer = rows[0] ?? null;
    }
    if (customer?.isWholesaler && !(Number(customer.creditLimit) > 0)) {
      throw new BadRequestException(
        'This customer is a Wholesaler with no Credit Limit assigned. Set a credit limit for this customer before raising this invoice.',
      );
    }
    const customerState = (customer?.state || '').toLowerCase();
    const isSameState = customerState === appConfig.companyState.toLowerCase();
    // Sum only the filtered (billing_category-matched) items' own gst_amount —
    // same fix as createFromOrder(), not a flat 18% of the filtered total.
    const gstAmount = items.reduce(
      (sum, it) => sum + Number(it.gst_amount || 0),
      0,
    );
    const cgst = isSameState ? gstAmount / 2 : 0;
    const sgst = isSameState ? gstAmount / 2 : 0;
    const igst = isSameState ? 0 : gstAmount;

    return this.invoiceRepository.manager.transaction(async (manager) => {
      // Generated inside the same transaction as the save — if anything
      // below fails, the counter increment rolls back with it instead of
      // being permanently burned (see generateDocNo).
      const invoice_no = await this.generateDocNo(manager, type);

      const invoice = manager.getRepository(Invoice).create({
        order_id: orderId,
        billing_company: billingCompany,
        invoice_no,
        type,
        total_amount: total,
        status: 'PENDING',
        gst_type: isSameState ? 'CGST_SGST' : 'IGST',
        cgst,
        sgst,
        igst,
        payment_terms: order.payment_terms,
        credit_days: order.credit_days,
        is_wholesaler: order.is_wholesaler,
      });

      return manager.save(invoice);
    });
  }

  async findSplitByOrder(orderId: number): Promise<Invoice[]> {
    return this.invoiceRepository.find({
      where: { order_id: orderId },
      order: { billing_company: 'ASC' },
    });
  }
}

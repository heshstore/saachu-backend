import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IsNull } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  private async generateInvoiceNo(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.invoiceRepository.count();
    return `INV-${year}-${String(count + 1).padStart(4, '0')}`;
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
        `SELECT id, "creditLimit", state FROM customer WHERE id = $1 LIMIT 1`,
        [order.customer_id],
      );
      customer = rows[0] ?? null;
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

    // GST split: CGST+SGST if same state, else IGST
    const total = Number(order.total_amount);
    const gstAmount = (total * 18) / 100;

    const customerState = (customer?.state || '').toLowerCase();
    const isSameState = customerState === appConfig.companyState.toLowerCase();

    const cgst = isSameState ? gstAmount / 2 : 0;
    const sgst = isSameState ? gstAmount / 2 : 0;
    const igst = isSameState ? 0 : gstAmount;

    const invoice_no = await this.generateInvoiceNo();

    const invoice = this.invoiceRepository.create({
      order_id: orderId,
      invoice_no,
      type,
      total_amount: total,
      status: 'PENDING',
      gst_type: isSameState ? 'CGST_SGST' : 'IGST',
      cgst,
      sgst,
      igst,
    });

    return this.invoiceRepository.save(invoice);
  }

  async findAll() {
    return this.invoiceRepository.find({ order: { id: 'DESC' } });
  }

  async findOne(id: number) {
    const rows = await this.invoiceRepository.manager.query<any[]>(
      `SELECT inv.*, o.order_no, o.status AS order_status,
              o.customer_id, o.customer_name, o.customer_phone,
              ${ORDER_SALESMAN_SELECT}
       FROM invoice inv
       JOIN orders o ON o.id = inv.order_id
       ${ORDER_SALESMAN_JOINS}
       WHERE inv.id = $1
       LIMIT 1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Invoice not found');
    await enrichRowsWithCustomerEmail(this.invoiceRepository.manager.connection, rows);
    await enrichRowsWithEmailCount(this.invoiceRepository.manager.connection, rows, 'invoice');
    await enrichRowsWithActionCounts(this.invoiceRepository.manager.connection, rows, 'invoice');
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

  private async generateSplitInvoiceNo(
    billingCompany: 'PRODUCTION' | 'TRADING',
  ): Promise<string> {
    const seqName =
      billingCompany === 'PRODUCTION'
        ? 'production_invoice_no_seq'
        : 'trading_invoice_no_seq';
    const prefix = billingCompany === 'PRODUCTION' ? 'PINV' : 'TINV';
    const rows = await this.invoiceRepository.manager.query<{ next: string }[]>(
      `SELECT nextval($1) AS next`,
      [seqName],
    );
    return `${prefix}-${new Date().getFullYear()}-${String(Number(rows[0].next)).padStart(4, '0')}`;
  }

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
        `SELECT id, "creditLimit", state FROM customer WHERE id = $1 LIMIT 1`,
        [order.customer_id],
      );
      customer = rows[0] ?? null;
    }
    const customerState = (customer?.state || '').toLowerCase();
    const isSameState = customerState === appConfig.companyState.toLowerCase();
    const gstAmount = (total * 18) / 100;
    const cgst = isSameState ? gstAmount / 2 : 0;
    const sgst = isSameState ? gstAmount / 2 : 0;
    const igst = isSameState ? 0 : gstAmount;

    const invoice_no = await this.generateSplitInvoiceNo(billingCompany);

    const invoice = this.invoiceRepository.create({
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
    });

    return this.invoiceRepository.save(invoice);
  }

  async findSplitByOrder(orderId: number): Promise<Invoice[]> {
    return this.invoiceRepository.find({
      where: { order_id: orderId },
      order: { billing_company: 'ASC' },
    });
  }
}

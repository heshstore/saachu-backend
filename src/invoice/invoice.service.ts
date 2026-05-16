import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { Invoice } from './entities/invoice.entity';
import { appConfig } from '../config/config';
import { ORDER_SALESMAN_JOINS, ORDER_SALESMAN_SELECT } from '../shared/ownership.util';

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
              ${ORDER_SALESMAN_SELECT}
       FROM invoice inv
       JOIN orders o ON o.id = inv.order_id
       ${ORDER_SALESMAN_JOINS}
       WHERE inv.id = $1
       LIMIT 1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Invoice not found');
    return rows[0];
  }

  create(body: any) {
    return body;
  }

  applySplit(id: number, body: any) {
    return { id, body };
  }
}

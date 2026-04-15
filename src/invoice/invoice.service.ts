import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { Invoice } from './entities/invoice.entity';
import { appConfig } from '../config/config';

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
      relations: ['items', 'customer'],
    });

    if (!order) throw new NotFoundException('Order not found');

    // Credit limit check
    const customer = order.customer;
    if (customer?.creditLimit && Number(customer.creditLimit) > 0) {
      const outstandingInvoices = await this.invoiceRepository
        .createQueryBuilder('inv')
        .where('inv.status != :paid', { paid: 'PAID' })
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
    const gstRate = Number(order.gst_percentage || 18);
    const gstAmount = (total * gstRate) / 100;

    const customerState = customer?.state || '';
    const isSameState =
      customerState.toLowerCase() === appConfig.companyState.toLowerCase();

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

    const saved = await this.invoiceRepository.save(invoice);

    // Move order to BILLED
    await this.orderRepository.update(orderId, { status: 'BILLED' });

    return saved;
  }

  async findAll() {
    return this.invoiceRepository.find({ order: { id: 'DESC' } });
  }

  async findOne(id: number) {
    const invoice = await this.invoiceRepository.findOne({ where: { id } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  create(body: any) {
    return body;
  }

  applySplit(id: number, body: any) {
    return { id, body };
  }
}

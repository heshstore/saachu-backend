import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/entities/order.entity';

@Injectable()
export class InvoiceService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  async createFromOrder(id: number, gstPercent: number) {
  const order = await this.orderRepository.findOne({
    where: { id },
    relations: ['items'],
  });

  if (!order) {
    throw new Error('Order not found');
  }

  const total = order.total_amount;

  // ✅ GST calculation (default 18%)
  const gstRate = 18;
  const gstAmount = (total * gstRate) / 100;

  // ✅ Apply % based on customer preference
  const appliedGst = (gstAmount * gstPercent) / 100;

  return {
    primary_invoice: {
      invoice_number: `INV-${order.id}`,
      total_amount: total,
      description: 'Main billing invoice',
    },

    secondary_invoice: {
      invoice_number: `TAX-${order.id}`,
      gst_amount: appliedGst,
      description: `Tax invoice (${gstPercent}% applied)`,
    },

    summary: {
      total_amount: total,
      total_gst: gstAmount,
      applied_gst: appliedGst,
    },
  };
}

  // (optional)
  findAll() {
    return [];
  }

  create(body: any) {
    return body;
  }

  applySplit(id: number, body: any) {
    return { id, body };
  }
}
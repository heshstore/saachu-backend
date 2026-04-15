import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Commission } from '../commission/entities/commission.entity';
import { User } from '../users/entities/user.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Item } from '../items/entities/item.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,

    @InjectRepository(OrderItem)
    private itemRepository: Repository<OrderItem>,

    @InjectRepository(Item)
    private productRepository: Repository<Item>,

    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,

    @InjectRepository(Commission)
    private commissionRepository: Repository<Commission>,

    private dataSource: DataSource,

  ) {}

  // 🚀 STRICT MODE PATCH: Find only pending approval orders
  async findPending() {
    return this.orderRepository.find({
      where: { status: 'PENDING_APPROVAL' },
      order: { id: 'DESC' },
    });
  }

  // ================= CREATE =================
  async create(data: any, user?: any) {
    if (!data) throw new Error('Request body missing');

    // Prevent duplicate order for same quotation
    if (data.quotation_id) {
      const existing = await this.orderRepository.findOne({ where: { quotation_id: Number(data.quotation_id) } });
      if (existing) throw new Error('Order already created for this quotation');
    }

    const items = data.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('At least one item required');
    }

    const safeNumber = (val: any) => (!isNaN(Number(val)) ? Number(val) : 0);

    // ── Map items — accepts both old { price } and new { rate } payloads ──────
    const mappedItems = items.map((item: any) => {
      const qty   = safeNumber(item.qty      ?? item.quantity);
      const price = safeNumber(item.rate     ?? item.price);   // new form sends `rate`
      const discountValue = safeNumber(item.discount_value);
      const discountType  = item.discount_type || 'percent';

      const baseAmount = qty * price;
      const discAmount = discountType === 'percent'
        ? (baseAmount * discountValue) / 100
        : discountValue;
      const amount = Math.max(0, baseAmount - discAmount);

      const orderItem          = new OrderItem();
      orderItem.itemName       = item.item_name || item.itemName || 'Item';
      orderItem.quantity       = qty;
      orderItem.rate           = price;
      orderItem.amount         = amount;
      orderItem.msp_price      = price;
      orderItem.discount_amount  = discountType === 'fixed'   ? discountValue : discAmount;
      orderItem.discount_percent = discountType === 'percent' ? discountValue : 0;
      return orderItem;
    });

    const subTotal = mappedItems.reduce((s: number, i: OrderItem) => s + i.amount, 0);
    // Total GST = sum of per-item GST amounts supplied by the form
    const totalGst = items.reduce((s: number, i: any) => s + safeNumber(i.gst_amount), 0);
    const totalAmount = subTotal + totalGst
      + safeNumber(data.charges_packing)
      + safeNumber(data.charges_cartage)
      + safeNumber(data.charges_forwarding)
      + safeNumber(data.charges_installation)
      + safeNumber(data.charges_loading);

    // Fetch customer
    let customer = null;
    if (data.customer_id && !isNaN(Number(data.customer_id))) {
      customer = await this.customerRepository.findOne({ where: { id: Number(data.customer_id) } });
    }

    // Sequential order number
    const lastOrder = await this.orderRepository.find({ order: { id: 'DESC' }, take: 1 });
    const nextNum   = lastOrder.length > 0 ? lastOrder[0].id + 1 : 1;

    const order: any = this.orderRepository.create({
      customer:          customer || null,
      customer_name:     data.customer_name || customer?.companyName || '',
      mobile:            customer?.mobile1  || '',
      order_number:      `ORD-${String(nextNum).padStart(5, '0')}`,
      total_amount:      totalAmount,
      taxable_amount:    subTotal,
      gst_bill_amount:   totalGst,
      non_gst_amount:    0,
      paid_amount:       0,
      pending_amount:    totalAmount,
      charges_packing:      safeNumber(data.charges_packing),
      charges_cartage:      safeNumber(data.charges_cartage),
      charges_forwarding:   safeNumber(data.charges_forwarding),
      charges_installation: safeNumber(data.charges_installation),
      charges_loading:      safeNumber(data.charges_loading),
      salesman_id: data.salesman_id && !isNaN(Number(data.salesman_id)) ? Number(data.salesman_id) : 1,
      credit_days: safeNumber(data.credit_days),
      due_date:    new Date(Date.now() + safeNumber(data.credit_days) * 86400000),
      status:      'PENDING_APPROVAL',
    } as any);

    order.items = mappedItems;

    const savedOrder = await this.orderRepository.save(order);
    return { id: savedOrder.id };
  }

  // ================= UPDATE =================
  async updateOrder(id: number, data: any) {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: ["items"],
    });

    if (!order) throw new Error('Order not found');

    // --- INSERTED CONSOLE LOGS BEFORE SAVING (per prompt) ---
    console.log("Incoming payload:", data);
    console.log("Items:", data?.items);

    const { customer_name, mobile, items } = data;

    // STRICT PATCH APPLIED TO UPDATE MAPPING TOO (for consistency)
    const mappedItems = await Promise.all(items.map(async (item) => {

      // item_id optional for now (STRICT PATCH)
      if (item.item_id && isNaN(Number(item.item_id))) {
        throw new Error('Invalid item_id');
      }

      // Removed: const dbItem = await this.itemRepository.findOne({ ... });

      const orderItem = new OrderItem();

      // ======= PATCH ADDED CODE STARTS HERE =======
      orderItem.itemName = item.itemName || 'Item';

      // REMOVE: orderItem.quantity = Number(item.qty ?? 0);
      // REMOVE: orderItem.rate = Number(item.price ?? 0);
      // REMOVE: orderItem.amount = Number(item.qty ?? 0) * Number(item.price ?? 0);

      // ADD:
      const qty = !isNaN(Number(item.qty)) ? Number(item.qty) : 0;
      const price = !isNaN(Number(item.price)) ? Number(item.price) : 0;

      orderItem.quantity = qty;
      orderItem.rate = price;
      orderItem.amount = qty * price;
      // ======= PATCH ADDED CODE ENDS HERE =======

      return orderItem;
    }));

    const totalAmount = mappedItems.reduce(
      (sum, item) => sum + item.amount,
      0,
    );

    order.customer_name = customer_name;
    order.mobile = mobile;
    order.items = mappedItems;

    order.total_amount = totalAmount;
    order.pending_amount = totalAmount - Number(order.paid_amount);

    const saved = await this.orderRepository.save(order);
    return this.formatOrder(saved);
  }

  // ================= APPROVE =================
  async approveOrder(id: number, user: any) {
    if (!user?.can_approve_order) {
      throw new Error('Not authorized');
    }

    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) {
      throw new Error('Order not found');
    }

    order.status = 'APPROVED';

    return this.orderRepository.save(order);
  }

  // 🚀 ADD BELOW APPROVE METHOD

  async rejectOrder(id: number, reason: string, user: any) {
    if (!user?.can_approve_order) {
      throw new Error('Not authorized');
    }

    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) {
      throw new Error('Order not found');
    }

    order.status = 'REJECTED';

    return this.orderRepository.save(order);
  }

  // ================= CONVERT TO ORDER =================
  async convertToOrder(id: number) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    order.status = 'APPROVED'; // Updated from 'order' to 'APPROVED'

    return this.formatOrder(await this.orderRepository.save(order));
  }

  // ================= SEND FOR APPROVAL =================
  async sendForApproval(id: number) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    order.status = 'PENDING_APPROVAL'; // Updated from 'pending_approval'

    return this.formatOrder(await this.orderRepository.save(order));
  }

  // ================= REJECT ORDER =================
  async rejectOrder_old(id: number, body: any) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    order.status = 'REJECTED'; // Updated from 'rejected'
    if ('rejection_remark' in order) {
      order.rejection_remark = body?.remark || 'Rejected';
    }

    return this.formatOrder(await this.orderRepository.save(order));
  }

  // ================= SEND TO PRODUCTION =================
  async sendToProduction(id: number) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    order.status = 'Production'; // Updated from 'production'

    return this.formatOrder(await this.orderRepository.save(order));
  }

  // ================= CANCEL =================
  async cancel(id: number) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    order.status = 'Cancelled'; // Updated from 'cancelled'

    const saved = await this.orderRepository.save(order);
    return this.formatOrder(saved);
  }

  // ================= INVOICE =================
  async splitInvoice(id: number) {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: ['items'],
    });

    if (!order) throw new Error('Order not found');

    return {
      order_number: order.id,
      customer_name: order.customer_name,
      mobile: order.mobile,

      items: order.items.map(item => ({
        item_name: item.itemName,
        quantity: item.quantity,
        rate: item.rate,
        amount: item.amount,
        gst: 18,
      })),

      subtotal: order.items.reduce((sum, i) => sum + i.amount, 0),
      gst_total: 0,
      total: order.items.reduce((sum, i) => sum + i.amount, 0),
    };
  }

  // ================= PAYMENT =================
  async addPayment(id: number, body: any) {
    const order = await this.orderRepository.findOne({ where: { id } });

    if (!order) throw new Error('Order not found');

    const payment = Number(body.amount || 0);

    order.paid_amount += payment;
    order.pending_amount =
      Number(order.total_amount) - Number(order.paid_amount);

    if (order.pending_amount <= 0) {
      order.status = 'Completed'; // Updated from 'completed'
    }

    await this.orderRepository.save(order);

    return this.formatOrder(order);
  }

  // ================= GET ALL =================
  async findAll() {
    const orders = await this.orderRepository.find({
      relations: ['items'],
      order: { id: 'DESC' },
    });

    return orders.map((o) => this.formatOrder(o));
  }

  // ================= FORMAT =================
  private formatOrder(order: any) {
    return {
      id: order.id, // ✅ CRITICAL FIX
      ...order,
      total_amount: Number(order.total_amount),
      paid_amount: Number(order.paid_amount),
      pending_amount: Number(order.pending_amount),
    };
  }
}
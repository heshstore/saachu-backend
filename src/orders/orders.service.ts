import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Commission } from '../commission/entities/commission.entity';
import { User } from '../users/entities/user.entity.ts';
import { Customer } from '../customers/entities/customer.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
  
    @InjectRepository(OrderItem)
    private itemRepository: Repository<OrderItem>,
  
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
    // 🚀 STRICT MODE PATCH: Only sales team can create orders

    // STEP 1: Top of create
    console.log('🔥 CREATE ORDER DATA:', data);

    // 🚀 STRICT MODE PATCH: Check for existing order by quotation_id
    if (data.quotation_id) {
      const existingOrder = await this.orderRepository.findOne({
        where: { quotation_id: Number(data.quotation_id) },
      });

      if (existingOrder) {
        throw new Error('Order already created for this quotation');
      }
    }

    if (
      user &&
      user.role &&
      !['Sales Manager', 'Territory Manager', 'Sales Executive'].includes(user.role)
    ) {
      throw new Error('Only sales team can create orders');
    }

    if (!data) throw new Error('Request body missing');

    const { customer_id, items } = data;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('At least one item required');
    }

    // ✅ VALIDATION BEFORE MAPPING
    items.forEach((item) => {
      if (!item.qty || isNaN(Number(item.qty))) {
        throw new Error('Invalid quantity');
      }

      if (!item.price || isNaN(Number(item.price))) {
        throw new Error('Invalid price');
      }
    });

    // ✅ STEP 1: CREATE ITEMS FIRST - STRICT PATCH MAPPING APPLIED
    const mappedItems = items.map(async (item) => {

      if (!item.qty || isNaN(Number(item.qty))) {
        throw new Error('Invalid quantity');
      }

      if (!item.price || isNaN(Number(item.price))) {
        throw new Error('Invalid price');
      }

      // ==== PATCH: Validate and fetch dbItem if item_id is provided
      if (!item.item_id || isNaN(Number(item.item_id))) {
        throw new Error('Invalid item_id');
      }

      const dbItem = await this.itemRepository.findOne({
        where: { id: Number(item.item_id) },
      });

      // STEP 2: Inside mapping
      console.log('🔥 ITEM:', item);

      const orderItem = new OrderItem();

      // PATCHED MAPPING:
      orderItem.itemName = item.itemName;
      orderItem.quantity = Number(item.qty) || 0;
      orderItem.rate = Number(item.price) || 0;
      orderItem.amount = Number(item.qty || 0) * Number(item.price || 0);

      // Keep old fields if present and needed, but do not overwrite above
      // Do not remove other existing mappings if absolutely necessary for system
      // (Retain these for backward compatibility)
      // orderItem.msp_price = msp;
      // orderItem.discount_amount = discountAmount;

      return orderItem;
    });

    // Need to await the mapping as we now have async calls (itemRepository)
    const mappedItemsResolved = await Promise.all(mappedItems);

    // ✅ STEP 2: CALCULATE TOTAL
    const totalAmount = mappedItemsResolved.reduce(
      (sum, item) => sum + item.amount,
      0,
    );

    // 🚀 STRICT MODE PATCH - fixed
    const gstPercent = Number(data.gst_percentage ?? 0) || 0;
    const gstSplitPercent = Number(data.gst_split_percent ?? 100) || 100;

    const taxableAmount = (totalAmount * gstSplitPercent) / 100;

    const gstAmount = Number(
      ((taxableAmount * gstPercent) / 100).toFixed(2),
    );

    const nonGstAmount = Number(
      (totalAmount - taxableAmount).toFixed(2),
    );

    const creditDays = Number(data.credit_days ?? 0) || 0;

    const count = await this.orderRepository.count();
    const orderNumber = `QTN-${new Date().getFullYear()}-${String(
      count + 1,
    ).padStart(3, '0')}`;

    // ✅ STEP 3: CREATE ORDER
    if (!data.customer_id || isNaN(Number(data.customer_id))) {
      throw new Error('Invalid customer_id');
    }

    const customer = await this.customerRepository.findOne({
      where: { id: Number(data.customer_id) },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }
    
    const order: any = this.orderRepository.create({
      customer: customer,

      order_number: orderNumber,
      total_amount: totalAmount,

      // 🚀 STRICT MODE PATCH - safe parse and fallback to 0
      charges_packing: Number(data.charges?.packing ?? 0) || 0,
      charges_cartage: Number(data.charges?.cartage ?? 0) || 0,
      charges_forwarding: Number(data.charges?.forwarding ?? 0) || 0,
      charges_installation: Number(data.charges?.installation ?? 0) || 0,
      charges_loading: Number(data.charges?.loading ?? 0) || 0,

      gst_percentage: gstPercent,
      gst_split_percent: gstSplitPercent,
      taxable_amount: taxableAmount,

      gst_bill_amount: gstAmount,
      non_gst_amount: nonGstAmount,

      paid_amount: 0,
      pending_amount: totalAmount,

      credit_days: creditDays,
      due_date: new Date(
        Date.now() + creditDays * 24 * 60 * 60 * 1000,
      ),

      commission_eligible: false,
      salesman_id: Number(data.salesman_id ?? 1) || 1, // ⬅️ PATCHED

      status: 'PENDING_APPROVAL', // 🚀 STRICT MODE PATCH: Status set to "PENDING_APPROVAL"
    } as any);

    // ✅ CRITICAL FIX
    order.items = mappedItemsResolved;

    // 🚨 STRICT MODE PATCH: Log order details before saving
    console.log('🚨 FINAL ORDER OBJECT:', {
      customer_id: data.customer_id,
      salesman_id: order.salesman_id,
      charges: {
        packing: order.charges_packing,
        cartage: order.charges_cartage,
        forwarding: order.charges_forwarding,
        installation: order.charges_installation,
        loading: order.charges_loading,
      },
      gst_percentage: order.gst_percentage,
      gst_split_percent: order.gst_split_percent,
      credit_days: order.credit_days,
      items: mappedItemsResolved,
    });

    // 🚀 STRICT MODE PATCH: Insert sequential order_number before saving
    const lastOrder = await this.orderRepository.find({
      order: { id: 'DESC' },
      take: 1,
    });

    let nextNumber = 1;

    if (lastOrder.length > 0) {
      nextNumber = lastOrder[0].id + 1;
    }

    const newOrderNumber = `ORD-${String(nextNumber).padStart(5, '0')}`;
    order.order_number = newOrderNumber;

    // ✅ SAVE
    const savedOrder = await this.orderRepository.save(order);

    return {
      id: savedOrder.id,
      order_number: savedOrder.order_number,
    };
  }

  // ================= UPDATE =================
  async updateOrder(id: number, data: any) {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: ["items"],
    });

    if (!order) throw new Error('Order not found');

    const { customer_name, mobile, items } = data;

    // STRICT PATCH APPLIED TO UPDATE MAPPING TOO (for consistency)
    const mappedItems = await Promise.all(items.map(async (item) => {

      // ==== PATCH: Validate and fetch dbItem if item_id is provided
      if (!item.item_id || isNaN(Number(item.item_id))) {
        throw new Error('Invalid item_id');
      }

      const dbItem = await this.itemRepository.findOne({
        where: { id: Number(item.item_id) },
      });

      const orderItem = new OrderItem();

      orderItem.itemName = item.itemName;
      orderItem.quantity = Number(item.qty) || 0;
      orderItem.rate = Number(item.price) || 0;
      orderItem.amount = Number(item.qty || 0) * Number(item.price || 0);

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
  async approveOrder(id: number, user: User) {
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

  async rejectOrder(id: number, reason: string, user: User) {
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
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { ProductionJob } from './entities/production-job.entity';
import { OrderItem } from './entities/order-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { ProductionService } from './production.service';
import { OrderExplosionService } from './order-explosion.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  enrichRowsWithSalesman,
  enrichRowsWithApprover,
  ORDER_SALESMAN_JOINS,
  ORDER_SALESMAN_SELECT,
} from '../shared/ownership.util';

// ── State machine ─────────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, OrderStatus[]> = {
  [OrderStatus.DRAFT]:              [OrderStatus.GENERATED, OrderStatus.PENDING_APPROVAL, OrderStatus.CANCELLED],
  [OrderStatus.GENERATED]:          [OrderStatus.PENDING_APPROVAL, OrderStatus.CANCELLED],
  [OrderStatus.PENDING_APPROVAL]:   [OrderStatus.APPROVED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
  [OrderStatus.APPROVED]:           [OrderStatus.IN_PRODUCTION, OrderStatus.CANCELLED],
  [OrderStatus.IN_PRODUCTION]:      [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]:              [OrderStatus.DISPATCHED, OrderStatus.PARTIAL_DISPATCHED, OrderStatus.CANCELLED],
  // Backward compat: existing DB rows written as READY_FOR_DISPATCH before rename.
  [OrderStatus.READY_FOR_DISPATCH]: [OrderStatus.DISPATCHED, OrderStatus.PARTIAL_DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.PARTIAL_DISPATCHED]: [OrderStatus.DISPATCHED, OrderStatus.PARTIAL_DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.DISPATCHED]:         [OrderStatus.PARTIAL_DELIVERED, OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.PARTIAL_DELIVERED]:  [OrderStatus.COMPLETED, OrderStatus.PARTIAL_DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]:          [],
  [OrderStatus.REJECTED]:           [OrderStatus.PENDING_APPROVAL, OrderStatus.CANCELLED],
  [OrderStatus.CANCELLED]:          [],
};

function assertTransition(from: OrderStatus, to: OrderStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    const msg = allowed.length
      ? `Invalid transition: ${from} → ${to}. Allowed: ${allowed.join(', ')}`
      : `${from} is a terminal state — no further transitions allowed`;
    throw new BadRequestException(msg);
  }
}

const IDEMPOTENCY_WINDOW_MINUTES = 5;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private orderRepo: Repository<Order>,
    @InjectRepository(Customer)
    private customerRepo: Repository<Customer>,
    private productionService: ProductionService,
    private explosionService: OrderExplosionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Order number generator — ORD0001 format ──────────────────────────────────
  private async generateOrderNo(): Promise<string> {
    const rows = await this.orderRepo.manager.query(
      `SELECT nextval('order_no_seq') AS next`,
    );
    const next = Number(rows[0].next);
    return `ORD${String(next).padStart(4, '0')}`;
  }

  // ── Customer snapshot ─────────────────────────────────────────────────────────
  private async snapshotCustomer(customerId: number): Promise<{
    customer_name: string;
    customer_phone: string;
    billing_address: string;
    shipping_address: string;
    gst_number: string;
  } | null> {
    const rows = await this.orderRepo.manager.query<any[]>(
      `SELECT "companyName", "contactName", "mobile1", "address", "city", "state", "pincode", "gstNumber"
       FROM customer WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    if (!rows.length) return null;
    const c = rows[0];
    const fullAddress = [c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ');
    return {
      customer_name:    c.companyName || c.contactName || '',
      customer_phone:   c.mobile1 || '',
      billing_address:  fullAddress,
      shipping_address: fullAddress,
      gst_number:       c.gstNumber || '',
    };
  }

  // ── Phone normalization ───────────────────────────────────────────────────────
  private normalizePhone(phone: string): string | null {
    if (!phone) return null;
    let p = phone.replace(/\D/g, '');
    if (p.length === 10)                              p = '91' + p;
    if (p.length === 11 && p.startsWith('0'))        p = '91' + p.slice(1);
    if (p.length === 12 && !p.startsWith('91'))      p = '91' + p;
    if (!p.startsWith('91') || p.length < 12)        return null;
    return '+' + p;
  }

  // ── Customer deduplication ────────────────────────────────────────────────────
  // Looks up by normalized mobile1. Only creates a new customer if not found.
  // Existing customer data is NEVER overwritten here.
  private async findOrCreateCustomer(input: {
    name?: string;
    phone: string;
    city?: string;
    state?: string;
    pincode?: string;
  }): Promise<Customer> {
    const phone = this.normalizePhone(input.phone);
    if (!phone) throw new BadRequestException('Valid customer phone is required');

    const existing = await this.customerRepo.findOne({ where: { mobile1: phone } });
    if (existing) return existing;

    return this.customerRepo.save(
      this.customerRepo.create({
        companyName:  input.name    || '',
        contactName:  input.name    || '',
        mobile1:      phone,
        city:         input.city    || '',
        state:        input.state   || '',
        pincode:      input.pincode || '',
      }),
    );
  }

  // ── Idempotency ───────────────────────────────────────────────────────────────
  // Hashes only stable business data — no timestamps, no user ids, no random values.
  private generateIdempotencyKey(payload: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  // ── Total calculation ─────────────────────────────────────────────────────────
  // Uses only normalized items — never reads rate/amount fields from raw DTO.
  private calcTotals(items: OrderItem[], data: any): { subtotal: number; total_amount: number } {
    const subtotal  = items.reduce((s, i) => s + Number(i.amount),     0);
    const gstTotal  = items.reduce((s, i) => s + Number(i.gst_amount), 0);

    const discountType  = data.discount_type  ?? 'PERCENT';
    const discountValue = Number(data.discount_value ?? 0);
    const headerDiscount = discountType === 'FLAT'
      ? discountValue
      : (subtotal * discountValue) / 100;

    const charges =
      Number(data.packing_charges      ?? data.charges_packing      ?? 0) +
      Number(data.cartage_charges      ?? data.charges_cartage      ?? 0) +
      Number(data.forwarding_charges   ?? data.charges_forwarding   ?? 0) +
      Number(data.installation_charges ?? data.charges_installation ?? 0) +
      Number(data.loading_charges      ?? data.charges_loading      ?? 0);

    return { subtotal, total_amount: Math.max(0, subtotal + gstTotal - headerDiscount + charges) };
  }

  // ── Item normalizer ───────────────────────────────────────────────────────────
  // Single source of truth for all item-level pricing.
  // rate / amount / gst_amount from the payload are IGNORED and always recomputed.
  private normalizeItem(input: any): Partial<OrderItem> {
    const round = (v: number) => Math.round(v * 100) / 100;

    const qty          = Number(input.qty ?? input.quantity) || 1;
    const baseRate     = Number(input.base_rate) || 0;
    const discountType = (input.discount_type || 'NONE').toUpperCase();
    const discountValue = Number(input.discount_value) || 0;

    let rate = baseRate;
    if (discountType === 'PERCENT') rate = baseRate - (baseRate * discountValue) / 100;
    if (discountType === 'FLAT')    rate = baseRate - discountValue;
    if (rate < 0) rate = 0;

    // Belt-and-suspenders: rate reduction is only valid when a discount type is applied.
    if (rate < baseRate && !['PERCENT', 'FLAT'].includes(discountType)) {
      throw new BadRequestException('Invalid pricing: rate cannot be reduced without a discount type');
    }

    const amount    = round(qty * rate);
    const gstPercent = Number(input.gst_percent) || 0;
    const gstAmount  = round((amount * gstPercent) / 100);

    return {
      sku:           input.sku        || '',
      item_name:     input.item_name  || input.itemName || '',
      hsn_code:      input.hsn_code   || input.hsnCode  || '',
      qty,
      base_rate:     baseRate,
      rate:          round(rate),
      discount_type: discountType,
      discount_value: discountValue,
      gst_percent:   gstPercent,
      amount,
      gst_amount:    gstAmount,
      instruction:   input.instruction || null,
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  async create(data: any, user?: any): Promise<Order> {
    if (!data) throw new BadRequestException('Request body missing');

    const rawItems = data.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new BadRequestException('At least one item required');
    }

    // Prevent duplicate order for same quotation
    if (data.quotation_id) {
      const existing = await this.orderRepo.findOne({
        where: { quotation_id: Number(data.quotation_id) },
      });
      if (existing) throw new ConflictException('Order already created for this quotation');
    }

    // Idempotency gate — hash of stable business data, checked within a rolling window.
    const idempotencyPayload = {
      customer_id: data.customer_id,
      items: rawItems.map(i => ({
        sku:           i.sku,
        qty:           i.qty,
        base_rate:     i.base_rate,
        discount_type: i.discount_type,
        discount_value: i.discount_value,
        gst_percent:   i.gst_percent,
      })),
      charges: {
        packing:      Number(data.packing_charges      ?? data.charges_packing      ?? 0),
        cartage:      Number(data.cartage_charges      ?? data.charges_cartage      ?? 0),
        forwarding:   Number(data.forwarding_charges   ?? data.charges_forwarding   ?? 0),
        installation: Number(data.installation_charges ?? data.charges_installation ?? 0),
        loading:      Number(data.loading_charges      ?? data.charges_loading      ?? 0),
      },
    };
    const idempotencyKey = this.generateIdempotencyKey(idempotencyPayload);

    const existing = await this.orderRepo.findOne({
      where: { idempotency_key: idempotencyKey },
      order: { created_at: 'DESC' },
    });
    if (existing) {
      const diffMinutes = (Date.now() - new Date(existing.created_at).getTime()) / 60000;
      if (diffMinutes <= IDEMPOTENCY_WINDOW_MINUTES) return existing;
    }

    const items = rawItems.map(i => Object.assign(new OrderItem(), this.normalizeItem(i)));
    const { subtotal, total_amount } = this.calcTotals(items, data);

    // Customer resolution:
    //   phone provided → find or create customer, snapshot from entity (no extra query)
    //   customer_id provided → snapshot via SQL (quotation conversion path)
    let resolvedCustomerId: number | undefined = data.customer_id ? Number(data.customer_id) : undefined;
    let snap: Awaited<ReturnType<typeof this.snapshotCustomer>> = null;

    if (data.customer_phone && !resolvedCustomerId) {
      const customer = await this.findOrCreateCustomer({
        name:    data.customer_name,
        phone:   data.customer_phone,
        city:    data.customer_city,
        state:   data.customer_state,
        pincode: data.customer_pincode,
      });
      resolvedCustomerId = customer.id;
      const addr = [customer.address, customer.city, customer.state, customer.pincode]
        .filter(Boolean).join(', ');
      snap = {
        customer_name:    customer.companyName || customer.contactName || '',
        customer_phone:   customer.mobile1 || '',
        billing_address:  addr,
        shipping_address: addr,
        gst_number:       customer.gstNumber || '',
      };
    } else if (resolvedCustomerId) {
      snap = await this.snapshotCustomer(resolvedCustomerId);
    }

    const order_no = await this.generateOrderNo();

    const order = this.orderRepo.create({
      order_no,
      quotation_id:        data.quotation_id ? Number(data.quotation_id) : undefined,
      customer_id:         resolvedCustomerId,
      lead_id:             data.lead_id      ? Number(data.lead_id)      : undefined,
      customer_name:       data.customer_name    ?? snap?.customer_name    ?? '',
      customer_phone:      data.customer_phone   ?? snap?.customer_phone   ?? '',
      billing_address:     data.billing_address  ?? snap?.billing_address  ?? '',
      shipping_address:    data.shipping_address ?? snap?.shipping_address ?? '',
      gst_number:          data.gst_number       ?? snap?.gst_number       ?? '',
      subtotal,
      discount_type:       data.discount_type  ?? 'PERCENT',
      discount_value:      Number(data.discount_value ?? 0),
      packing_charges:     Number(data.packing_charges      ?? data.charges_packing      ?? 0),
      cartage_charges:     Number(data.cartage_charges      ?? data.charges_cartage      ?? 0),
      forwarding_charges:  Number(data.forwarding_charges   ?? data.charges_forwarding   ?? 0),
      installation_charges:Number(data.installation_charges ?? data.charges_installation ?? 0),
      loading_charges:     Number(data.loading_charges      ?? data.charges_loading      ?? 0),
      total_amount,
      status:              (data.status as OrderStatus) || OrderStatus.DRAFT,
      paid_amount:         0,
      pending_amount:      total_amount,
      salesman_id:         data.salesman_id ? Number(data.salesman_id) : undefined,
      created_by:              user?.id,
      idempotency_key:         idempotencyKey,
      idempotency_created_at:  new Date(),
      items,
    });

    const saved = await this.orderRepo.save(order);

    // Sync legacy NOT-NULL columns that the TypeORM entity doesn't map.
    // The migration sets DEFAULT '' / 0 so the INSERT succeeds; these UPDATEs
    // populate them with real data for tooling that reads the legacy columns.
    await this.orderRepo.manager
      .query(
        `UPDATE orders SET mobile = $1, order_number = $2 WHERE id = $3`,
        [saved.customer_phone || '', saved.order_no || '', saved.id],
      )
      .catch(() => {});

    // order_item legacy columns: itemName, quantity, msp_price are NOT NULL with
    // no DEFAULT and not in the TypeORM entity. Populate from modern equivalents.
    await this.orderRepo.manager
      .query(
        `UPDATE order_item
         SET "itemName" = COALESCE(NULLIF(item_name, ''), 'Item'),
             quantity   = qty::integer,
             msp_price  = COALESCE(rate, 0)
         WHERE "orderId" = $1`,
        [saved.id],
      )
      .catch(() => {});

    this.eventEmitter.emit('order.created', {
      id:            saved.id,
      salesman_id:   saved.salesman_id,
      customer_name: saved.customer_name,
    });

    // Non-blocking — planning data is best-effort and must not block order save
    this.explosionService.explode(saved.id).catch(err =>
      this.logger.warn(`[OrderExplosion] create failed for order ${saved.id}: ${err?.message}`),
    );

    return saved;
  }

  // ── Read ──────────────────────────────────────────────────────────────────────

  async findAll(
    filters: any = {},
    user?: any,
  ): Promise<{ data: Order[]; total: number; page: number; limit: number }> {
    const limit = Math.min(Number(filters.limit) || 50, 200); // hard cap at 200
    const page  = Math.max(Number(filters.page)  || 1,  1);

    const qb = this.orderRepo
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'items')
      .orderBy('o.id', 'DESC')
      .take(limit)
      .skip((page - 1) * limit);

    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (user?.role && !fullAccessRoles.includes(user.role) && user.id) {
      qb.andWhere('(o.created_by = :userId OR o.salesman_id = :userId)', { userId: user.id });
    }

    if (filters.status)      qb.andWhere('o.status = :status',    { status: filters.status });
    if (filters.customer_id) qb.andWhere('o.customer_id = :cid',  { cid: filters.customer_id });
    if (filters.from_date)   qb.andWhere('o.created_at >= :from', { from: filters.from_date });
    if (filters.to_date)     qb.andWhere('o.created_at <= :to',   { to: filters.to_date });

    const [data, total] = await qb.getManyAndCount();
    const ds = this.orderRepo.manager.connection;
    await enrichRowsWithSalesman(ds, data as any[]);
    await enrichRowsWithApprover(ds, data as any[]);

    // Attach quotation_no for orders sourced from quotations (single batch lookup,
    // avoids N+1 queries). quotation_id is an integer FK — no ORM relation defined.
    const quotationIds = data.filter(o => o.quotation_id).map(o => o.quotation_id);
    if (quotationIds.length > 0) {
      const qRows: { id: number; quotation_no: string }[] = await this.orderRepo.manager.query(
        `SELECT id, quotation_no FROM quotation WHERE id = ANY($1)`,
        [quotationIds],
      );
      const qnoMap = new Map(qRows.map(r => [Number(r.id), r.quotation_no]));
      (data as any[]).forEach(o => {
        o.quotation_no = o.quotation_id ? (qnoMap.get(o.quotation_id) ?? null) : null;
      });
    }

    return { data, total, page, limit };
  }

  async findOne(id: number): Promise<Order> {
    const rows: any[] = await this.orderRepo.manager.query(
      `SELECT o.*, ${ORDER_SALESMAN_SELECT}
       FROM orders o
       ${ORDER_SALESMAN_JOINS}
       WHERE o.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Order not found');
    const items = await this.orderRepo.manager.find(OrderItem, {
      where: { order_id: id },
    });
    return { ...rows[0], items } as Order;
  }

  async findPending(): Promise<Order[]> {
    return this.orderRepo.find({
      where: { status: OrderStatus.PENDING_APPROVAL },
      order: { id: 'DESC' },
    });
  }

  // ── Transition helper ─────────────────────────────────────────────────────────

  private async transition(id: number, to: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    assertTransition(order.status, to);
    order.status = to;
    const saved = await this.orderRepo.save(order);
    this.eventEmitter.emit('order.updated', { orderId: saved.id, status: saved.status });
    return saved;
  }

  // ── Status transitions ────────────────────────────────────────────────────────

  async approveOrder(id: number, remarks: string | undefined, user: any): Promise<Order> {
    let savedOrder!: Order;
    let createdJobs: ProductionJob[] = [];

    await this.orderRepo.manager.transaction(async (em) => {
      // Lock the order row for the duration of the transaction.
      // loadEagerRelations: false is required — the Order entity has eager items via
      // OneToMany, which TypeORM loads with a LEFT JOIN.  PostgreSQL forbids
      // FOR UPDATE on the nullable side of an outer join, so the lock + eager load
      // combination throws "FOR UPDATE cannot be applied to the nullable side of an
      // outer join".  We load items separately below, without the lock constraint.
      const order = await em.findOne(Order, {
        where:              { id },
        lock:               { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      });
      if (!order) throw new NotFoundException('Order not found');
      assertTransition(order.status, OrderStatus.APPROVED);

      // Load items in the same transaction — no lock needed on them.
      order.items = await em.find(OrderItem, { where: { order: { id } } });

      order.status      = OrderStatus.APPROVED;
      order.approved_by = user?.id ?? null;
      order.approved_at = new Date();
      // advance_amount / process_without_advance / approval_remarks (salesperson notes)
      // are intentionally NOT touched here — they are operational data that must persist.

      savedOrder  = await em.save(order);
      createdJobs = await this.productionService.createFromOrder(savedOrder, em);
    });

    // Auto-assign runs after the transaction commits — jobs must be visible to
    // all connections before we try to assign them to workers.
    for (const job of createdJobs) {
      await this.productionService.autoAssignJob(job);
    }

    // Notify ProductionExecutionService to generate BOQ-based execution jobs
    this.eventEmitter.emit('order.approved', {
      orderId: savedOrder.id,
      order_no: savedOrder.order_no,
      user_id: user?.id ?? null,
      user_name: user?.name ?? null,
      user_role: user?.role ?? null,
    });

    return this.findOne(savedOrder.id);
  }

  async rejectOrder(id: number, remarks: string | undefined, user: any): Promise<Order> {
    const order = await this.findOne(id);
    assertTransition(order.status, OrderStatus.REJECTED);
    order.status            = OrderStatus.REJECTED;
    order.approved_by       = user?.id ?? null;
    order.approved_at       = new Date();
    order.rejection_reason  = remarks || null;
    // advance_amount / process_without_advance / approval_remarks are NOT touched —
    // they are the salesperson's operational data and must survive rejection.
    const saved = await this.orderRepo.save(order);
    this.eventEmitter.emit('order.updated', { orderId: saved.id, status: saved.status });
    return saved;
  }

  async sendForApproval(
    id: number,
    data?: { advance_amount?: number; process_without_advance?: boolean; remarks?: string },
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (order.status === OrderStatus.PENDING_APPROVAL) return order;
    assertTransition(order.status, OrderStatus.PENDING_APPROVAL);

    order.status = OrderStatus.PENDING_APPROVAL;

    // Persist structured fields individually so the modal can pre-fill them on re-submission.
    // Only update a field if the caller explicitly provided it (undefined = keep existing value).
    if (data?.advance_amount !== undefined) {
      order.advance_amount = Number(data.advance_amount) || 0;
    }
    if (data?.process_without_advance !== undefined) {
      order.process_without_advance = Boolean(data.process_without_advance);
    }
    if (data?.remarks !== undefined) {
      order.approval_remarks = data.remarks || null;
    }

    // Clear any previous rejection reason — order is being re-submitted.
    order.rejection_reason = null;

    return this.orderRepo.save(order);
  }

  async sendToProduction(id: number): Promise<Order> {
    return this.transition(id, OrderStatus.IN_PRODUCTION);
  }

  async complete(id: number): Promise<Order> {
    return this.transition(id, OrderStatus.COMPLETED);
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.transition(id, OrderStatus.CANCELLED);
    await this.productionService.cancelJobsForOrder(id);
    return order;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async updateOrder(id: number, data: any): Promise<Order> {
    const order = await this.findOne(id);
    const EDITABLE = [OrderStatus.DRAFT, OrderStatus.GENERATED, OrderStatus.PENDING_APPROVAL, OrderStatus.REJECTED];
    if (!EDITABLE.includes(order.status)) {
      throw new BadRequestException({
        message:        `Orders in ${order.status} status cannot be edited`,
        code:           'ORDER_NOT_EDITABLE',
        current_status: order.status,
      });
    }

    delete data.subtotal;
    delete data.total_amount;
    delete data.status;

    if (data.items) {
      if (!Array.isArray(data.items) || data.items.length === 0) {
        throw new BadRequestException('Order must contain at least one item');
      }
      const items = data.items.map(i => Object.assign(new OrderItem(), this.normalizeItem(i)));
      const { subtotal, total_amount } = this.calcTotals(items, { ...order, ...data });
      data.items         = items;
      data.subtotal      = subtotal;
      data.total_amount  = total_amount;
      data.pending_amount = Math.max(0, total_amount - Number(order.paid_amount));
    }

    await this.orderRepo.save({ ...order, ...data });

    // Non-blocking re-explosion — re-calculates planning if items changed
    this.explosionService.explode(id).catch(err =>
      this.logger.warn(`[OrderExplosion] update failed for order ${id}: ${err?.message}`),
    );

    return this.findOne(id);
  }

  // ── Legacy alias used by quotation service ────────────────────────────────────

  async convertToOrder(id: number): Promise<Order> {
    return this.transition(id, OrderStatus.APPROVED);
  }

  // ── Payment (legacy — PaymentService is authoritative for new code) ───────────

  async addPayment(id: number, body: any): Promise<Order> {
    const order = await this.findOne(id);
    const amount = Number(body.amount || 0);
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero');

    order.paid_amount    = Number(order.paid_amount) + amount;
    order.pending_amount = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
    const saved = await this.orderRepo.save(order);
    this.eventEmitter.emit('payment.received', {
      order_id:  id,
      order_no:  order.order_no,
      amount,
      user_id:   body.user_id   ?? null,
      user_name: body.user_name ?? null,
    });
    return saved;
  }

  // ── Split invoice (reporting helper) ─────────────────────────────────────────

  async splitInvoice(id: number) {
    const order = await this.findOne(id);
    return {
      order_no: order.order_no,
      order_number: order.order_no,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      mobile: order.customer_phone,
      status: order.status,
      salesman_name: (order as any).salesman_name,
      salesman_phone: (order as any).salesman_phone,
      salesman_role: (order as any).salesman_role,
      approved_by_name: (order as any).approved_by_name,
      approved_by_role: (order as any).approved_by_role,
      approved_at: (order as any).approved_at,
      created_by_name: (order as any).created_by_name,
      created_by_role: (order as any).created_by_role,
      items: (order.items || []).map(i => ({
        item_name: i.item_name,
        sku: i.sku,
        qty: i.qty,
        quantity: i.qty,
        rate: i.rate,
        gst_percent: i.gst_percent,
        gst: i.gst_percent,
        amount: i.amount,
        gst_amount: i.gst_amount,
      })),
      subtotal: order.subtotal,
      total: order.total_amount,
      charges: {
        packing: Number(order.packing_charges || 0),
        cartage: Number(order.cartage_charges || 0),
        forwarding: Number(order.forwarding_charges || 0),
        installation: Number((order as any).installation_charges || 0),
        loading: Number((order as any).loading_charges || 0),
      },
    };
  }
}

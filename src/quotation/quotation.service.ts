import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Quotation, QuotationStatus, QuotationDiscountType } from './quotation.entity';
import { QuotationItem } from './quotation-item.entity';
import { appConfig } from '../config/config';
import { OrdersService } from '../orders/orders.service';
import { ItemsService } from '../items/items.service';

@Injectable()
export class QuotationService {
  constructor(
    @InjectRepository(Quotation)
    private quotationRepo: Repository<Quotation>,
    @InjectRepository(QuotationItem)
    private quotationItemRepo: Repository<QuotationItem>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
    private itemsService: ItemsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Quotation number generator — QUO0001 format ──────────────────────────────
  // Uses a Postgres sequence for atomic, collision-free increment.
  // nextval() never returns the same value twice, even under concurrent load,
  // and does not roll back if the surrounding transaction is aborted.

  private async generateQuotationNo(): Promise<string> {
    const rows = await this.quotationRepo.manager.query(
      `SELECT nextval('quotation_no_seq') AS next`,
    );
    const next = Number(rows[0].next);
    return `QUO${String(next).padStart(4, '0')}`;
  }

  // ── Customer snapshot ─────────────────────────────────────────────────────────

  /**
   * Reads the customer record once and returns immutable snapshot fields.
   * Called at creation time; the result is stored on the quotation and never
   * refreshed from the live customer table afterward.
   */
  private async snapshotCustomer(customerId: number): Promise<{
    customer_name: string;
    customer_phone: string;
    billing_address: string;
    shipping_address: string;
    gst_number: string;
  } | null> {
    const rows = await this.quotationRepo.manager.query<any[]>(
      `SELECT "companyName", "contactName", "mobile1", "address", "city", "state", "pincode", "gstNumber"
       FROM customer WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    if (!rows.length) return null;
    const c = rows[0];
    const addressParts = [c.address, c.city, c.state, c.pincode].filter(Boolean);
    const fullAddress  = addressParts.join(', ');
    return {
      customer_name:    c.companyName || c.contactName || '',
      customer_phone:   c.mobile1 || '',
      billing_address:  fullAddress,
      shipping_address: fullAddress,
      gst_number:       c.gstNumber || '',
    };
  }

  // ── Customer type resolution ──────────────────────────────────────────────────

  /**
   * Returns isWholesaler for the given customer_id by reading the customer table.
   * Falls back to false (retail) when no customer_id is provided.
   */
  private async resolveIsWholesaler(customerId: number | undefined, fallback: boolean): Promise<boolean> {
    if (!customerId) return fallback;
    const rows = await this.quotationRepo.manager.query<{ isWholesaler: boolean }[]>(
      `SELECT "isWholesaler" FROM customer WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    return rows.length > 0 ? !!rows[0].isWholesaler : fallback;
  }

  // ── Base price resolution ─────────────────────────────────────────────────────

  /**
   * Returns the floor price for a SKU based on customer type.
   * Wholesaler → wholesale_price (fallback: sellingPrice).
   * Retail     → retail_price   (fallback: sellingPrice).
   * Returns 0 when SKU is not in the item master (manual line item — no constraint).
   */
  private async resolveBaseRate(sku: string, isWholesaler: boolean): Promise<number> {
    if (!sku) return 0;
    const master = await this.itemsService.findBySku(sku);
    if (!master) return 0;
    return isWholesaler
      ? Number(master.wholesale_price || master.sellingPrice)
      : Number(master.retail_price   || master.sellingPrice);
  }

  // ── Item mapping ─────────────────────────────────────────────────────────────

  /**
   * Maps raw line items → QuotationItem entities.
   * Resolves base_rate from the item master per customer type.
   * Throws BadRequestException if rate < base_rate.
   */
  private async mapItems(rawItems: any[], isWholesaler: boolean): Promise<QuotationItem[]> {
    const items: QuotationItem[] = [];

    for (const item of rawItems || []) {
      const sku      = (item.sku || '').trim();
      const rate     = Number(item.rate) || 0;
      const base_rate = await this.resolveBaseRate(sku, isWholesaler);

      if (base_rate > 0 && rate < base_rate) {
        throw new BadRequestException(
          `Rate ₹${rate} for "${sku || item.item_name}" is below the minimum price of ₹${base_rate}` +
          (isWholesaler ? ' (wholesale)' : ' (retail)'),
        );
      }

      const qi          = new QuotationItem();
      qi.sku            = sku;
      qi.item_name      = item.item_name || item.itemName || '';
      qi.instruction    = item.instruction || '';
      qi.qty            = Number(item.qty) || 1;
      qi.base_rate      = base_rate;
      qi.rate           = rate;
      qi.discount_type  = item.discount_type || 'percent';
      qi.discount_value = Number(item.discount_value) || 0;
      qi.gst_percent    = Number(item.gst_percent) || 0;
      qi.hsn_code       = item.hsn_code || item.hsnCode || '';

      const lineTotal = qi.qty * qi.rate;
      const discount  = qi.discount_type === 'percent'
        ? (lineTotal * qi.discount_value) / 100
        : qi.discount_value;
      qi.amount = lineTotal - discount;

      items.push(qi);
    }

    return items;
  }

  // ── Total calculation ─────────────────────────────────────────────────────────

  private calcTotals(
    items: QuotationItem[],
    data: any,
    existing?: Quotation,
  ): { sub_total: number; total_amount: number } {
    const sub_total = items.reduce((s, i) => s + Number(i.amount), 0);

    const charges =
      Number(data.charges_packing       ?? existing?.charges_packing       ?? 0) +
      Number(data.charges_cartage       ?? existing?.charges_cartage       ?? 0) +
      Number(data.charges_forwarding    ?? existing?.charges_forwarding    ?? 0) +
      Number(data.charges_installation  ?? existing?.charges_installation  ?? 0) +
      Number(data.charges_loading       ?? existing?.charges_loading       ?? 0);

    const discountType  = data.discount_type  ?? existing?.discount_type  ?? QuotationDiscountType.PERCENT;
    const discountValue = Number(data.discount_value ?? existing?.discount_value ?? 0);
    const headerDiscount = discountType === QuotationDiscountType.FLAT
      ? discountValue
      : (sub_total * discountValue) / 100;

    return { sub_total, total_amount: sub_total - headerDiscount + charges };
  }

  // ── Guards ────────────────────────────────────────────────────────────────────

  private assertEditable(quotation: Quotation): void {
    if (quotation.status !== QuotationStatus.DRAFT) {
      throw new ForbiddenException('Only DRAFT quotations can be modified');
    }
  }

  // Fields that are locked once a quotation leaves DRAFT status:
  //   customer_id  — changing the customer would invalidate the historical record
  //   items        — line items are part of the agreed-upon quote
  //   snapshot fields — billing/shipping/GST are frozen at creation for the same reason
  private static readonly DRAFT_ONLY_FIELDS = new Set([
    'customer_id',
    'items',
    'customer_name',
    'customer_phone',
    'billing_address',
    'shipping_address',
    'gst_number',
  ]);

  // ── Create ────────────────────────────────────────────────────────────────────

  async create(data: any, user?: any): Promise<Quotation> {
    // If lead_id is provided, auto-fill customer_id from the lead record.
    if (data.lead_id && !data.customer_id) {
      const leadRows = await this.quotationRepo.manager.query<{ customer_id: number | null }[]>(
        `SELECT customer_id FROM leads WHERE id = $1 AND is_active = true LIMIT 1`,
        [data.lead_id],
      );
      if (leadRows.length > 0 && leadRows[0].customer_id) {
        data.customer_id = leadRows[0].customer_id;
      }
    }

    if (!data.customer_id) {
      throw new BadRequestException(
        'customer_id is required. If creating from a lead, the lead must be converted to a customer first.',
      );
    }

    // Lead-based idempotency — one DRAFT per lead
    if (data.lead_id) {
      const existing = await this.quotationRepo.findOne({
        where: { lead_id: data.lead_id, status: QuotationStatus.DRAFT },
        relations: ['items'],
      });
      if (existing) return existing;
    }

    // Customer idempotency within configured window
    const windowStart = new Date(Date.now() - appConfig.idempotencyWindowSeconds * 1000);
    const recent = await this.quotationRepo.findOne({
      where: { customer_id: data.customer_id, created_at: MoreThanOrEqual(windowStart), status: QuotationStatus.DRAFT },
    });
    if (recent) return recent;

    // Totals are always derived — strip any user-supplied values immediately.
    delete data.sub_total;
    delete data.total_amount;

    const quotation_no  = await this.generateQuotationNo();
    const validityDays  = data.validity_days || 15;
    const valid_till    = new Date();
    valid_till.setDate(valid_till.getDate() + validityDays);

    // Fetch isWholesaler from the customer record — payload value is a fallback only.
    const isWholesaler = await this.resolveIsWholesaler(data.customer_id, !!data.is_wholesaler);
    const items = await this.mapItems(data.items, isWholesaler);
    const { sub_total, total_amount } = this.calcTotals(items, data);

    // Snapshot customer at creation — immutable historical record.
    const snap = await this.snapshotCustomer(data.customer_id);

    const quotation = this.quotationRepo.create({
      quotation_no,
      lead_id:               data.lead_id,
      customer_id:           data.customer_id,
      customer_name:         data.customer_name    ?? snap?.customer_name    ?? '',
      customer_phone:        data.customer_phone   ?? snap?.customer_phone   ?? '',
      billing_address:       data.billing_address  ?? snap?.billing_address  ?? '',
      shipping_address:      data.shipping_address ?? snap?.shipping_address ?? '',
      gst_number:            data.gst_number       ?? snap?.gst_number       ?? '',
      bill_to_id:            data.bill_to_id,
      ship_to_id:            data.ship_to_id,
      salesman_id:           data.salesman_id || user?.id,
      status:                QuotationStatus.DRAFT,
      validity_days:         validityDays,
      valid_till,
      delivery_by:           data.delivery_by,
      delivery_type:         data.delivery_type,
      payment_type:          data.payment_type,
      delivery_instructions: data.delivery_instructions,
      discount_type:         data.discount_type  ?? QuotationDiscountType.PERCENT,
      discount_value:        data.discount_value ?? 0,
      charges_packing:       data.charges_packing      || 0,
      charges_cartage:       data.charges_cartage      || 0,
      charges_forwarding:    data.charges_forwarding   || 0,
      charges_installation:  data.charges_installation || 0,
      charges_loading:       data.charges_loading      || 0,
      sub_total,
      total_amount,
      created_by:   user?.id,
      is_wholesaler: !!data.is_wholesaler,
      items,
    });

    const saved = await this.quotationRepo.save(quotation);
    this.eventEmitter.emit('quotation.created', {
      id: saved.id, quotation_no: saved.quotation_no,
      customer_name: saved.customer_name, total_amount: saved.total_amount,
      user_id: user?.id ?? null, user_name: user?.name ?? null,
    });
    return saved;
  }

  // ── Read ──────────────────────────────────────────────────────────────────────

  async findAll(filters: any = {}, user?: any): Promise<Quotation[]> {
    const qb = this.quotationRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.items', 'items')
      .where('q.status != :cancelled', { cancelled: QuotationStatus.CANCELLED })
      .orderBy('q.id', 'DESC');

    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (user?.role && !fullAccessRoles.includes(user.role) && user.id) {
      qb.andWhere('q.created_by = :userId', { userId: user.id });
    }

    if (filters.status)      qb.andWhere('q.status = :status',  { status: filters.status });
    if (filters.salesman_id) qb.andWhere('q.salesman_id = :sid', { sid: filters.salesman_id });
    if (filters.from_date)   qb.andWhere('q.created_at >= :from', { from: filters.from_date });
    if (filters.to_date)     qb.andWhere('q.created_at <= :to',   { to: filters.to_date });

    return qb.getMany();
  }

  async findOne(id: number): Promise<Quotation> {
    const q = await this.quotationRepo.findOne({ where: { id }, relations: ['items'], withDeleted: false });
    if (!q) throw new NotFoundException('Quotation not found');
    return q;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async update(id: number, data: any, user?: any): Promise<Quotation> {
    const quotation = await this.findOne(id);

    // Totals are always derived — strip any user-supplied values immediately.
    delete data.sub_total;
    delete data.total_amount;

    // Block restricted fields on non-DRAFT quotations.
    if (quotation.status !== QuotationStatus.DRAFT) {
      const restricted = Object.keys(data).filter(k => QuotationService.DRAFT_ONLY_FIELDS.has(k));
      if (restricted.length > 0) {
        throw new ForbiddenException('Only DRAFT quotations can be modified');
      }
    }

    let effectiveItems = quotation.items;

    if (data.items) {
      await this.quotationItemRepo.delete({ quotation: { id } as any });
      const isWholesaler = await this.resolveIsWholesaler(
        data.customer_id ?? quotation.customer_id,
        data.is_wholesaler ?? quotation.is_wholesaler,
      );
      effectiveItems = await this.mapItems(data.items, isWholesaler);
      data.items = effectiveItems;
    }

    // Always recalculate — charge-only or discount-only changes must also update totals.
    const { sub_total, total_amount } = this.calcTotals(effectiveItems, data, quotation);
    data.sub_total    = sub_total;
    data.total_amount = total_amount;

    // Re-snapshot if customer changed (only reachable on DRAFT due to guard above).
    if (data.customer_id && data.customer_id !== quotation.customer_id) {
      const snap = await this.snapshotCustomer(data.customer_id);
      if (snap) {
        data.customer_name    = data.customer_name    ?? snap.customer_name;
        data.customer_phone   = data.customer_phone   ?? snap.customer_phone;
        data.billing_address  = data.billing_address  ?? snap.billing_address;
        data.shipping_address = data.shipping_address ?? snap.shipping_address;
        data.gst_number       = data.gst_number       ?? snap.gst_number;
      }
    }

    data.version = (quotation.version || 1) + 1;
    await this.quotationRepo.save({ ...quotation, ...data });
    return this.findOne(id);
  }

  // ── Status transitions ────────────────────────────────────────────────────────

  async send(id: number): Promise<Quotation> {
    const quotation = await this.findOne(id);
    this.assertEditable(quotation);
    quotation.status = QuotationStatus.SENT;
    const saved = await this.quotationRepo.save(quotation);
    this.eventEmitter.emit('quotation.sent', { id, quotation_no: saved.quotation_no });
    return saved;
  }

  async approve(id: number): Promise<Quotation> {
    const quotation = await this.findOne(id);
    if (quotation.status !== QuotationStatus.SENT) {
      throw new ForbiddenException('Only SENT quotations can be approved');
    }
    quotation.status = QuotationStatus.APPROVED;
    const saved = await this.quotationRepo.save(quotation);
    this.eventEmitter.emit('quotation.approved', { id, quotation_no: saved.quotation_no, user_id: null, user_name: null });
    return saved;
  }

  async reject(id: number, user?: any): Promise<Quotation> {
    const quotation = await this.findOne(id);
    if (![QuotationStatus.SENT, QuotationStatus.DRAFT].includes(quotation.status)) {
      throw new ForbiddenException('Only DRAFT or SENT quotations can be rejected');
    }
    quotation.status = QuotationStatus.REJECTED;
    const saved = await this.quotationRepo.save(quotation);
    this.eventEmitter.emit('quotation.rejected', { id, quotation_no: saved.quotation_no, user_id: user?.id ?? null, user_name: user?.name ?? null });
    return saved;
  }

  async cancel(id: number, user?: any): Promise<Quotation> {
    const quotation = await this.findOne(id);
    if ([QuotationStatus.CONVERTED, QuotationStatus.CANCELLED].includes(quotation.status)) {
      throw new ForbiddenException(`Cannot cancel a ${quotation.status} quotation`);
    }
    quotation.status       = QuotationStatus.CANCELLED;
    quotation.cancelled_at = new Date();
    quotation.cancelled_by = user?.id;
    return this.quotationRepo.save(quotation);
  }

  // ── Soft delete ───────────────────────────────────────────────────────────────

  async softDelete(id: number, user?: any): Promise<{ message: string }> {
    const quotation = await this.findOne(id);
    if ([QuotationStatus.CONVERTED].includes(quotation.status)) {
      throw new ForbiddenException(`Cannot delete a ${quotation.status} quotation`);
    }
    await this.quotationRepo.softDelete(id);
    return { message: `Quotation ${quotation.quotation_no} deleted` };
  }

  // ── Convert to order ──────────────────────────────────────────────────────────

  async convertToOrder(id: number, user?: any): Promise<{ order_id: number; quotation_id: number }> {
    const quotation = await this.findOne(id);
    if (![QuotationStatus.APPROVED, QuotationStatus.SENT, QuotationStatus.DRAFT].includes(quotation.status)) {
      throw new ForbiddenException(`Cannot convert a ${quotation.status} quotation to an order`);
    }

    const order = await this.ordersService.create({
      customer_id:          quotation.customer_id,
      customer_name:        quotation.customer_name,
      customer_phone:       quotation.customer_phone,
      billing_address:      quotation.billing_address,
      shipping_address:     quotation.shipping_address,
      gst_number:           quotation.gst_number,
      salesman_id:          quotation.salesman_id,
      discount_type:        quotation.discount_type,
      discount_value:       quotation.discount_value,
      packing_charges:      quotation.charges_packing,
      cartage_charges:      quotation.charges_cartage,
      forwarding_charges:   quotation.charges_forwarding,
      installation_charges: quotation.charges_installation,
      loading_charges:      quotation.charges_loading,
      quotation_id:         quotation.id,
      items: (quotation.items || []).map((i) => ({
        item_name:      i.item_name,
        sku:            i.sku,
        hsn_code:       i.hsn_code,
        qty:            i.qty,
        base_rate:      i.base_rate,
        rate:           i.rate,
        discount_type:  i.discount_type,
        discount_value: i.discount_value,
        gst_percent:    i.gst_percent,
        amount:         i.amount,
        gst_amount:     Number(i.amount || 0) * Number(i.gst_percent || 0) / 100,
        instruction:    i.instruction,
      })),
    }, user);

    quotation.status = QuotationStatus.CONVERTED;
    await this.quotationRepo.save(quotation);

    return { order_id: order.id, quotation_id: id };
  }
}

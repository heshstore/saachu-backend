import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Quotation } from './quotation.entity';
import { QuotationItem } from './quotation-item.entity';
import { appConfig } from '../config/config';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class QuotationService {
  constructor(
    @InjectRepository(Quotation)
    private quotationRepo: Repository<Quotation>,
    @InjectRepository(QuotationItem)
    private quotationItemRepo: Repository<QuotationItem>,
    @Inject(forwardRef(() => OrdersService))
    private ordersService: OrdersService,
  ) {}

  private async generateQuotationNo(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.quotationRepo.count();
    return `QUO-${year}-${String(count + 1).padStart(4, '0')}`;
  }

  async create(data: any, user?: any) {
    const windowStart = new Date(Date.now() - appConfig.idempotencyWindowSeconds * 1000);
    if (data.customer_id) {
      const recent = await this.quotationRepo.findOne({
        where: {
          customer_id: data.customer_id,
          created_at: MoreThanOrEqual(windowStart),
          status: 'OPEN',
        },
      });
      if (recent) {
        return recent;
      }
    }

    const quotation_no = await this.generateQuotationNo();

    const validityDays = data.validity_days || 15;
    const validTill = new Date();
    validTill.setDate(validTill.getDate() + validityDays);

    const mappedItems = (data.items || []).map((item: any) => {
      const qi = new QuotationItem();
      qi.sku = item.sku || '';
      qi.item_name = item.item_name || item.itemName || '';
      qi.instruction = item.instruction || '';
      qi.qty = Number(item.qty) || 1;
      qi.rate = Number(item.rate) || 0;
      qi.discount_type = item.discount_type || 'percent';
      qi.discount_value = Number(item.discount_value) || 0;
      qi.gst_percent = Number(item.gst_percent) || 0;
      qi.hsn_code = item.hsn_code || item.hsnCode || '';

      const baseAmount = qi.qty * qi.rate;
      const discountAmount =
        qi.discount_type === 'percent'
          ? (baseAmount * qi.discount_value) / 100
          : qi.discount_value;
      qi.amount = baseAmount - discountAmount;
      return qi;
    });

    const subTotal = mappedItems.reduce((sum: number, i: QuotationItem) => sum + Number(i.amount), 0);
    const totalAmount =
      subTotal +
      Number(data.charges_packing || 0) +
      Number(data.charges_cartage || 0) +
      Number(data.charges_forwarding || 0) +
      Number(data.charges_installation || 0) +
      Number(data.charges_loading || 0);

    const quotation = this.quotationRepo.create({
      quotation_no,
      customer_id: data.customer_id,
      customer_name: data.customer_name,
      bill_to_id: data.bill_to_id,
      ship_to_id: data.ship_to_id,
      salesman_id: data.salesman_id || user?.id,
      status: 'OPEN',
      validity_days: validityDays,
      valid_till: validTill,
      delivery_by: data.delivery_by,
      delivery_type: data.delivery_type,
      payment_type: data.payment_type,
      delivery_instructions: data.delivery_instructions,
      charges_packing: data.charges_packing || 0,
      charges_cartage: data.charges_cartage || 0,
      charges_forwarding: data.charges_forwarding || 0,
      charges_installation: data.charges_installation || 0,
      charges_loading: data.charges_loading || 0,
      sub_total: subTotal,
      total_amount: totalAmount,
      created_by: user?.id,
      is_wholesaler: !!data.is_wholesaler,
      items: mappedItems,
    });

    return this.quotationRepo.save(quotation);
  }

  async findAll(filters: any = {}, user?: any) {
    const qb = this.quotationRepo.createQueryBuilder('q')
      .leftJoinAndSelect('q.items', 'items')
      .where('q.status != :cancelled', { cancelled: 'CANCELLED' })
      .orderBy('q.id', 'DESC');

    // Data isolation: non-privileged roles see only own records
    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (user?.role && !fullAccessRoles.includes(user.role) && user.id) {
      qb.andWhere('q.created_by = :userId', { userId: user.id });
    }

    if (filters.status) {
      qb.andWhere('q.status = :status', { status: filters.status });
    }
    if (filters.salesman_id) {
      qb.andWhere('q.salesman_id = :sid', { sid: filters.salesman_id });
    }
    if (filters.from_date) {
      qb.andWhere('q.created_at >= :from', { from: filters.from_date });
    }
    if (filters.to_date) {
      qb.andWhere('q.created_at <= :to', { to: filters.to_date });
    }

    return qb.getMany();
  }

  async findOne(id: number) {
    const q = await this.quotationRepo.findOne({
      where: { id },
      relations: ['items'],
    });
    if (!q) throw new NotFoundException('Quotation not found');
    return q;
  }

  async update(id: number, data: any, user?: any) {
    const quotation = await this.findOne(id);
    if (quotation.status !== 'OPEN') {
      throw new ForbiddenException('Only OPEN quotations can be edited');
    }

    if (data.items) {
      await this.quotationItemRepo.delete({ quotation: { id } as any });

      const mappedItems = data.items.map((item: any) => {
        const qi = new QuotationItem();
        qi.sku = item.sku || '';
        qi.item_name = item.item_name || item.itemName || '';
        qi.instruction = item.instruction || '';
        qi.qty = Number(item.qty) || 1;
        qi.rate = Number(item.rate) || 0;
        qi.discount_type = item.discount_type || 'percent';
        qi.discount_value = Number(item.discount_value) || 0;
        qi.gst_percent = Number(item.gst_percent) || 0;
        qi.hsn_code = item.hsn_code || item.hsnCode || '';

        const baseAmount = qi.qty * qi.rate;
        const discountAmount =
          qi.discount_type === 'percent'
            ? (baseAmount * qi.discount_value) / 100
            : qi.discount_value;
        qi.amount = baseAmount - discountAmount;
        return qi;
      });

      data.items = mappedItems;
      data.sub_total = mappedItems.reduce((s: number, i: QuotationItem) => s + Number(i.amount), 0);
      data.total_amount =
        data.sub_total +
        Number(data.charges_packing || quotation.charges_packing || 0) +
        Number(data.charges_cartage || quotation.charges_cartage || 0) +
        Number(data.charges_forwarding || quotation.charges_forwarding || 0) +
        Number(data.charges_installation || quotation.charges_installation || 0) +
        Number(data.charges_loading || quotation.charges_loading || 0);
    }

    data.version = (quotation.version || 1) + 1;
    await this.quotationRepo.save({ ...quotation, ...data });
    return this.findOne(id);
  }

  async cancel(id: number, user?: any) {
    const quotation = await this.findOne(id);
    quotation.status = 'CANCELLED';
    quotation.cancelled_at = new Date();
    quotation.cancelled_by = user?.id;
    return this.quotationRepo.save(quotation);
  }

  async convertToOrder(id: number, user?: any) {
    const quotation = await this.findOne(id);
    if (quotation.status !== 'OPEN') {
      throw new ForbiddenException('Only OPEN quotations can be converted');
    }

    const orderPayload: any = {
      customer_id:           quotation.customer_id,
      customer_name:         quotation.customer_name,
      salesman_id:           quotation.salesman_id,
      bill_to_id:            quotation.bill_to_id,
      ship_to_id:            quotation.ship_to_id,
      delivery_type:         quotation.delivery_type,
      payment_type:          quotation.payment_type,
      charges_packing:       quotation.charges_packing,
      charges_cartage:       quotation.charges_cartage,
      charges_forwarding:    quotation.charges_forwarding,
      charges_installation:  quotation.charges_installation,
      charges_loading:       quotation.charges_loading,
      quotation_id:          quotation.id,
      items: (quotation.items || []).map((i: any) => ({
        item_name:      i.item_name,
        sku:            i.sku,
        hsn_code:       i.hsn_code,
        qty:            i.qty,
        rate:           i.rate,
        discount_type:  i.discount_type,
        discount_value: i.discount_value,
        gst_percent:    i.gst_percent,
        amount:         i.amount,
        gst_amount:     Number(i.amount || 0) * Number(i.gst_percent || 0) / 100,
        instruction:    i.instruction,
      })),
    };

    const order = await this.ordersService.create(orderPayload, user);

    quotation.status = 'CONVERTED';
    await this.quotationRepo.save(quotation);

    return { order_id: order.id, quotation_id: id };
  }
}

import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { DispatchOrder } from './entities/dispatch-order.entity';
import { DispatchOrderItem } from './entities/dispatch-order-item.entity';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { InventoryTransaction } from '../inventory/entities/inventory-transaction.entity';

const EPS = 1e-6;

const SQL_DISPATCH_CONFIRMED = `d.status IN ('PARTIAL_DISPATCHED','DISPATCHED','PARTIAL_DELIVERED','DELIVERED')`;

@Injectable()
export class DispatchOrdersService {
  constructor(
    @InjectRepository(DispatchOrder)
    private readonly dispatchOrderRepo: Repository<DispatchOrder>,

    private readonly dataSource: DataSource,
  ) {}

  private async nextDispatchNumber(m?: EntityManager): Promise<string> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(`SELECT nextval('dispatch_order_number_seq')::bigint AS n`);
    const n = String(rows[0].n).padStart(6, '0');
    const y = new Date().getFullYear();
    return `DO-${y}-${n}`;
  }

  private async resolveItemId(sku: string | null, m?: EntityManager): Promise<number | null> {
    if (!sku?.trim()) return null;
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT id FROM service_items WHERE sku = $1 AND is_active = true LIMIT 1`,
      [sku.trim()],
    );
    if (rows.length) return Number(rows[0].id);
    const shop: any[] = await q(
      `SELECT id FROM shopify_catalog_items WHERE sku = $1 LIMIT 1`,
      [sku.trim()],
    );
    return shop.length ? Number(shop[0].id) : null;
  }

  /** Ledger FG qty (all warehouses) */
  async getFgStock(itemId: number, m?: EntityManager): Promise<number> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN qty WHEN direction = 'OUT' THEN -qty ELSE 0 END),0)::float AS q
       FROM inventory_transactions WHERE item_id = $1`,
      [itemId],
    );
    return Number(rows[0]?.q) || 0;
  }

  private async stockByWarehouse(itemId: number, m?: EntityManager): Promise<{ warehouseId: number; qty: number }[]> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT t.warehouse_id AS "warehouseId",
              COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.qty WHEN t.direction = 'OUT' THEN -t.qty ELSE 0 END),0)::float AS qty
       FROM inventory_transactions t WHERE t.item_id = $1
       GROUP BY t.warehouse_id
       HAVING COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.qty WHEN t.direction = 'OUT' THEN -t.qty ELSE 0 END),0) > $2
       ORDER BY qty DESC, t.warehouse_id ASC`,
      [itemId, EPS],
    );
    return rows.map((r) => ({ warehouseId: Number(r.warehouseId), qty: Number(r.qty) }));
  }

  /** Already dispatched (confirmed) per order_item */
  private async dispatchedTotalsByOrderItem(orderId: number, m?: EntityManager): Promise<Map<number, number>> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT doi.order_item_id AS oid, SUM(doi.dispatched_qty)::float AS s
       FROM dispatch_order_items doi
       JOIN dispatch_orders d ON d.id = doi.dispatch_order_id
       WHERE d.order_id = $1 AND ${SQL_DISPATCH_CONFIRMED}
       GROUP BY doi.order_item_id`,
      [orderId],
    );
    const map = new Map<number, number>();
    for (const r of rows) map.set(Number(r.oid), Number(r.s) || 0);
    return map;
  }

  private async deliveredTotalsByOrderItem(orderId: number, m?: EntityManager): Promise<Map<number, number>> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT doi.order_item_id AS oid, SUM(doi.delivered_qty)::float AS s
       FROM dispatch_order_items doi
       JOIN dispatch_orders d ON d.id = doi.dispatch_order_id
       WHERE d.order_id = $1 AND d.status NOT IN ('DRAFT','READY','CANCELLED')
       GROUP BY doi.order_item_id`,
      [orderId],
    );
    const map = new Map<number, number>();
    for (const r of rows) map.set(Number(r.oid), Number(r.s) || 0);
    return map;
  }

  private async syncOrderStatusFromDispatch(orderId: number, m: EntityManager): Promise<void> {
    const order = await m.findOne(Order, { where: { id: orderId } });
    if (!order) return;
    const allowed = new Set<string>([
      OrderStatus.READY,
      OrderStatus.READY_FOR_DISPATCH,
      OrderStatus.PARTIAL_DISPATCHED,
      OrderStatus.DISPATCHED,
      OrderStatus.PARTIAL_DELIVERED,
    ]);
    if (!allowed.has(order.status as string)) return;

    const items: any[] = await m.query(
      `SELECT id, qty::float AS q FROM order_item WHERE "orderId" = $1`,
      [orderId],
    );
    const disp = await this.dispatchedTotalsByOrderItem(orderId, m);
    const delv = await this.deliveredTotalsByOrderItem(orderId, m);

    let anyDel = false;
    let allDel = items.length > 0;
    let anyDisp = false;
    let allDisp = items.length > 0;

    for (const it of items) {
      const oid = Number(it.id);
      const oq = Number(it.q) || 0;
      const dq = disp.get(oid) ?? 0;
      const lq = delv.get(oid) ?? 0;
      if (lq > EPS) anyDel = true;
      if (lq + EPS < oq) allDel = false;
      if (dq > EPS) anyDisp = true;
      if (dq + EPS < oq) allDisp = false;
    }

    let next = order.status as OrderStatus;
    if (anyDel && allDel) next = OrderStatus.COMPLETED;
    else if (anyDel) next = OrderStatus.PARTIAL_DELIVERED;
    else if (anyDisp && allDisp) next = OrderStatus.DISPATCHED;
    else if (anyDisp) next = OrderStatus.PARTIAL_DISPATCHED;
    else next = order.status;

    if (next !== order.status) {
      await m.update(Order, { id: orderId }, { status: next });
    }
  }

  async findDispatchOrders(orderId?: number): Promise<any[]> {
    const params: any[] = [];
    let where = '';
    if (orderId) {
      params.push(orderId);
      where = `WHERE d.order_id = $${params.length}`;
    }
    return this.dataSource.query(
      `SELECT d.*, o.order_no AS "orderNo", o.customer_name AS "customerName", o.status AS "orderStatus"
       FROM dispatch_orders d
       JOIN orders o ON o.id = d.order_id
       ${where}
       ORDER BY d.created_at DESC`,
      params,
    );
  }

  async findDispatchOrderById(id: number): Promise<any> {
    const heads: any[] = await this.dataSource.query(
      `SELECT d.*, o.order_no AS "orderNo", o.customer_name AS "customerName", o.status AS "orderStatus"
       FROM dispatch_orders d
       JOIN orders o ON o.id = d.order_id
       WHERE d.id = $1`,
      [id],
    );
    if (!heads.length) throw new NotFoundException(`Dispatch order ${id} not found`);
    const head = heads[0];

    const lines: any[] = await this.dataSource.query(
      `SELECT doi.*,
              oi.sku AS "orderSku",
              oi.item_name AS "orderItemName"
       FROM dispatch_order_items doi
       JOIN order_item oi ON oi.id = doi.order_item_id
       WHERE doi.dispatch_order_id = $1
       ORDER BY doi.id`,
      [id],
    );

    for (const L of lines) {
      L.fgStockAvailable = await this.getFgStock(Number(L.item_id));
    }

    return { ...head, lines };
  }

  async createDraftFromOrder(orderId: number, userId?: number): Promise<DispatchOrder> {
    return this.dataSource.transaction(async (m) => {
      const order = await m.findOne(Order, {
        where: { id: orderId },
        relations: ['items'],
        lock:    { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);

      const ok = new Set([
        OrderStatus.READY,
        OrderStatus.READY_FOR_DISPATCH,
        OrderStatus.PARTIAL_DISPATCHED,
        OrderStatus.DISPATCHED,
        OrderStatus.PARTIAL_DELIVERED,
      ]);
      if (!ok.has(order.status as OrderStatus)) {
        throw new BadRequestException(
          `Order must be ready for fulfillment (current: ${order.status})`,
        );
      }

      const already = await this.dispatchedTotalsByOrderItem(orderId, m);
      const lines: DispatchOrderItem[] = [];
      for (const oi of order.items ?? []) {
        const oid = oi.id;
        const oq = Number(oi.qty) || 0;
        const prior = already.get(oid) ?? 0;
        const remaining = Math.max(0, oq - prior);
        if (remaining <= EPS) continue;
        const itemId = await this.resolveItemId(oi.sku, m);
        if (!itemId) {
          throw new BadRequestException(
            `Cannot create dispatch line: no catalog item for SKU "${oi.sku ?? ''}"`,
          );
        }
        lines.push(m.create(DispatchOrderItem, {
          orderItemId:   oid,
          itemId,
          orderedQty:    remaining,
          pendingQty:    remaining,
          dispatchedQty: 0,
          packedQty:     0,
          deliveredQty:  0,
        }));
      }

      if (!lines.length) {
        throw new BadRequestException('Nothing left to dispatch for this order');
      }

      const num = await this.nextDispatchNumber(m);
      const head = m.create(DispatchOrder, {
        dispatchNumber: num,
        orderId,
        customerId: order.customer_id ?? null,
        status:     'DRAFT',
        createdBy:  userId ?? null,
      });
      const saved = await m.save(head);
      for (const ln of lines) ln.dispatchOrderId = saved.id;
      await m.save(lines);
      const r = await m.findOne(DispatchOrder, { where: { id: saved.id }, relations: ['lines'] });
      if (!r) throw new NotFoundException('Dispatch order not found after create');
      return r;
    });
  }

  async updateHeader(
    id: number,
    body: {
      remarks?: string;
      transporterName?: string;
      lrNumber?: string;
      trackingNumber?: string;
      status?: 'DRAFT' | 'READY';
      packingCost?: number;
      logisticsCost?: number;
      miscCost?: number;
    },
  ): Promise<DispatchOrder> {
    const d = await this.dispatchOrderRepo.findOne({ where: { id } });
    if (!d) throw new NotFoundException(`Dispatch order ${id} not found`);
    if (['DISPATCHED', 'PARTIAL_DISPATCHED', 'DELIVERED', 'PARTIAL_DELIVERED', 'CANCELLED'].includes(d.status)) {
      throw new BadRequestException(`Cannot edit header in status ${d.status}`);
    }
    if (body.remarks !== undefined) d.remarks = body.remarks;
    if (body.transporterName !== undefined) d.transporterName = body.transporterName;
    if (body.lrNumber !== undefined) d.lrNumber = body.lrNumber;
    if (body.trackingNumber !== undefined) d.trackingNumber = body.trackingNumber;
    if (body.status === 'READY' || body.status === 'DRAFT') d.status = body.status;
    if (body.packingCost !== undefined) d.packingCost = Number(body.packingCost) || 0;
    if (body.logisticsCost !== undefined) d.logisticsCost = Number(body.logisticsCost) || 0;
    if (body.miscCost !== undefined) d.miscCost = Number(body.miscCost) || 0;
    return this.dispatchOrderRepo.save(d);
  }

  async packLine(
    dispatchOrderId: number,
    lineId: number,
    body: { packedQty: number; packingRemarks?: string; cartonCount?: number },
  ): Promise<DispatchOrderItem> {
    return this.dataSource.transaction(async (m) => {
      const line = await m.findOne(DispatchOrderItem, {
        where: { id: lineId, dispatchOrderId },
        lock:  { mode: 'pessimistic_write' },
      });
      if (!line) throw new NotFoundException('Dispatch line not found');

      const head = await m.findOne(DispatchOrder, { where: { id: dispatchOrderId } });
      if (!head || ['CANCELLED', 'DISPATCHED', 'PARTIAL_DISPATCHED', 'DELIVERED', 'PARTIAL_DELIVERED'].includes(head.status)) {
        throw new BadRequestException('Cannot pack in current dispatch status');
      }

      const oi = await m.findOne(OrderItem, { where: { id: line.orderItemId } });
      if (!oi) throw new NotFoundException('Order item missing');

      const orderQty = Number(oi.qty) || 0;
      const totals = await this.dispatchedTotalsByOrderItem(head.orderId, m);
      const excl = await m.query(
        `SELECT COALESCE(SUM(doi.dispatched_qty),0)::float AS s
         FROM dispatch_order_items doi
         WHERE doi.dispatch_order_id = $1 AND doi.id <> $2`,
        [dispatchOrderId, lineId],
      );
      const otherThisDoc = Number(excl[0]?.s) || 0;
      const priorOther = (totals.get(line.orderItemId) ?? 0) - otherThisDoc - line.dispatchedQty;
      const maxPack = Math.max(0, orderQty - priorOther);
      const pq = Number(body.packedQty);
      if (pq < 0 || pq > maxPack + EPS) {
        throw new BadRequestException(`packedQty must be between 0 and ${maxPack} for this line`);
      }

      line.packedQty = pq;
      if (body.packingRemarks !== undefined) line.packingRemarks = body.packingRemarks ?? null;
      if (body.cartonCount !== undefined) line.cartonCount = body.cartonCount ?? null;
      return m.save(line);
    });
  }

  async markInTransit(id: number, body?: { transporterName?: string; lrNumber?: string; trackingNumber?: string }): Promise<DispatchOrder> {
    return this.dataSource.transaction(async (m) => {
      const d = await m.findOne(DispatchOrder, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw new NotFoundException(`Dispatch order ${id} not found`);
      if (!['DISPATCHED', 'PARTIAL_DISPATCHED'].includes(d.status)) {
        throw new BadRequestException('Dispatch must be confirmed before marking in transit');
      }
      d.inTransitAt = new Date();
      if (body?.transporterName !== undefined) d.transporterName = body.transporterName;
      if (body?.lrNumber !== undefined) d.lrNumber = body.lrNumber;
      if (body?.trackingNumber !== undefined) d.trackingNumber = body.trackingNumber;
      return m.save(d);
    });
  }

  async confirmDispatch(dispatchOrderId: number, userId?: number): Promise<DispatchOrder> {
    return this.dataSource.transaction(async (m) => {
      const head = await m.findOne(DispatchOrder, {
        where: { id: dispatchOrderId },
        relations: ['lines'],
        lock:    { mode: 'pessimistic_write' },
      });
      if (!head) throw new NotFoundException(`Dispatch order ${dispatchOrderId} not found`);
      if (!['DRAFT', 'READY'].includes(head.status)) {
        throw new BadRequestException(`Cannot confirm dispatch from status ${head.status}`);
      }

      const totals = await this.dispatchedTotalsByOrderItem(head.orderId, m);

      let anyLine = false;
      for (const line of head.lines ?? []) {
        const shipQty = Number(line.packedQty) || 0;
        if (shipQty <= EPS) continue;
        anyLine = true;

        const oi = await m.findOne(OrderItem, { where: { id: line.orderItemId } });
        if (!oi) throw new BadRequestException('Order item missing');
        const orderQty = Number(oi.qty) || 0;
        const prior = (totals.get(line.orderItemId) ?? 0);
        if (prior + shipQty > orderQty + EPS) {
          throw new BadRequestException(`Dispatch exceeds ordered qty for line ${line.orderItemId}`);
        }

        const fg = await this.getFgStock(line.itemId, m);
        if (fg + EPS < shipQty) {
          throw new BadRequestException(
            `Insufficient FG stock for item #${line.itemId}: need ${shipQty}, available ${fg}`,
          );
        }

        let remaining = shipQty;
        const balances = await this.stockByWarehouse(line.itemId, m);
        for (const b of balances) {
          if (remaining <= EPS) break;
          const take = Math.min(remaining, b.qty);
          if (take <= EPS) continue;
          await m.save(m.create(InventoryTransaction, {
            itemId:          line.itemId,
            warehouseId:     b.warehouseId,
            transactionType: 'SALES_DISPATCH',
            direction:       'OUT',
            qty:             take,
            unit:            'PCS',
            rate:            null,
            referenceType:   'DISPATCH_ORDER',
            referenceId:     head.id,
            notes:           `Order item ${line.orderItemId}; dispatch ${head.dispatchNumber}`,
            createdBy:       userId ?? null,
          }));
          remaining -= take;
        }
        if (remaining > EPS) {
          throw new BadRequestException(`Stock allocation failed for item ${line.itemId}`);
        }

        line.dispatchedQty = shipQty;
        const afterGlobal = prior + shipQty;
        line.pendingQty = Math.max(0, orderQty - afterGlobal);
        await m.save(line);
      }

      if (!anyLine) {
        throw new BadRequestException('Set packed quantities before confirming dispatch');
      }

      head.dispatchDate = new Date();

      const items: any[] = await m.query(
        `SELECT id, qty::float AS q FROM order_item WHERE "orderId" = $1`,
        [head.orderId],
      );
      const newTotals = await this.dispatchedTotalsByOrderItem(head.orderId, m);
      let allDisp = true;
      for (const it of items) {
        const dqty = newTotals.get(Number(it.id)) ?? 0;
        if (dqty + EPS < Number(it.q)) allDisp = false;
      }
      head.status = allDisp ? 'DISPATCHED' : 'PARTIAL_DISPATCHED';

      await m.save(head);
      await this.syncOrderStatusFromDispatch(head.orderId, m);
      return head;
    });
  }

  async updateDelivery(
    dispatchOrderId: number,
    body: { lines: { id: number; deliveredQty: number }[] },
    userId?: number,
  ): Promise<DispatchOrder> {
    return this.dataSource.transaction(async (m) => {
      const head = await m.findOne(DispatchOrder, {
        where: { id: dispatchOrderId },
        relations: ['lines'],
        lock:    { mode: 'pessimistic_write' },
      });
      if (!head) throw new NotFoundException(`Dispatch order ${dispatchOrderId} not found`);
      if (head.status === 'DELIVERED') return head;

      if (!['DISPATCHED', 'PARTIAL_DISPATCHED', 'PARTIAL_DELIVERED', 'DELIVERED'].includes(head.status)) {
        if (head.status === 'DRAFT' || head.status === 'READY') {
          throw new BadRequestException('Confirm dispatch before recording delivery');
        }
        throw new BadRequestException(`Cannot record delivery in status ${head.status}`);
      }

      for (const u of body.lines ?? []) {
        const line = head.lines?.find((l) => l.id === u.id);
        if (!line) throw new BadRequestException(`Unknown line ${u.id}`);
        const dq = Number(u.deliveredQty);
        if (dq < 0 || dq > line.dispatchedQty + EPS) {
          throw new BadRequestException(`deliveredQty invalid for line ${u.id}`);
        }
        line.deliveredQty = dq;
        await m.save(line);
      }

      let allDel = true;
      for (const line of head.lines ?? []) {
        if (line.deliveredQty + EPS < line.dispatchedQty) allDel = false;
      }
      head.status = allDel ? 'DELIVERED' : 'PARTIAL_DELIVERED';
      if (allDel) head.deliveredAt = new Date();
      await m.save(head);
      await this.syncOrderStatusFromDispatch(head.orderId, m);
      void userId;
      return head;
    });
  }

  async cancelDraft(id: number): Promise<DispatchOrder> {
    const d = await this.dispatchOrderRepo.findOne({ where: { id } });
    if (!d) throw new NotFoundException(`Dispatch order ${id} not found`);
    if (!['DRAFT', 'READY'].includes(d.status)) {
      throw new BadRequestException('Only draft dispatch orders can be cancelled');
    }
    d.status = 'CANCELLED';
    return this.dispatchOrderRepo.save(d);
  }
}

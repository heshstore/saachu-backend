import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { VendorsService } from '../vendors/vendors.service';

const PO_STATUSES = ['DRAFT', 'SENT', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED'];

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepo: Repository<PurchaseOrder>,
    private readonly dataSource: DataSource,
    private readonly vendorsService: VendorsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async nextPoNumber(): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT 'PO' || LPAD(nextval('po_number_seq')::text, 5, '0') AS n`,
    );
    return String(rows[0]?.n ?? `PO${Date.now()}`);
  }

  async resolveItemMeta(itemId: number): Promise<{ itemSource: string; gst: number }> {
    const svc = await this.dataSource.query(
      `SELECT id, gst FROM service_items WHERE id = $1 AND is_active = true LIMIT 1`,
      [itemId],
    );
    if (svc.length) return { itemSource: 'SERVICE', gst: Number(svc[0].gst ?? 0) };
    const sh = await this.dataSource.query(
      `SELECT id, gst FROM shopify_catalog_items WHERE id = $1 AND sync_ignored = false LIMIT 1`,
      [itemId],
    );
    if (sh.length) return { itemSource: 'SHOPIFY', gst: Number(sh[0].gst ?? 0) };
    throw new BadRequestException(`Item ${itemId} not found in service or Shopify catalog`);
  }

  async findAll(filters: { status?: string; vendorId?: number } = {}): Promise<any[]> {
    const cond: string[] = [];
    const params: any[] = [];
    if (filters.status) {
      params.push(filters.status);
      cond.push(`po.status = $${params.length}`);
    }
    if (filters.vendorId) {
      params.push(filters.vendorId);
      cond.push(`po.vendor_id = $${params.length}`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return this.dataSource.query(
      `SELECT
         po.*,
         v.vendor_name AS "vendorName",
         v.vendor_code AS "vendorCode",
         (SELECT COUNT(*)::int FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS "itemCount"
       FROM purchase_orders po
       JOIN vendors v ON v.id = po.vendor_id
       ${where}
       ORDER BY po.created_at DESC`,
      params,
    );
  }

  async findOne(id: number): Promise<any> {
    const rows = await this.dataSource.query(
      `SELECT po.*, v.vendor_name AS "vendorName", v.vendor_code AS "vendorCode"
       FROM purchase_orders po
       JOIN vendors v ON v.id = po.vendor_id
       WHERE po.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Purchase order ${id} not found`);
    const po = rows[0];
    const items = await this.dataSource.query(
      `SELECT i.*,
         COALESCE(si.item_name, sci.item_name) AS "itemName",
         COALESCE(si.item_code, sci.item_code) AS "itemCode"
       FROM purchase_order_items i
       LEFT JOIN service_items si ON si.id = i.item_id AND i.item_source = 'SERVICE'
       LEFT JOIN shopify_catalog_items sci ON sci.id = i.item_id AND i.item_source = 'SHOPIFY'
       WHERE i.purchase_order_id = $1
       ORDER BY i.id`,
      [id],
    );
    return { ...po, items };
  }

  /**
   * Merge selected purchase requirements into one PO for a vendor.
   * PRs must be PENDING or APPROVED. Each distinct item must have a vendor_item_mapping.
   */
  async createFromRequirements(data: {
    vendorId: number;
    purchaseRequirementIds: number[];
    warehouseId?: number | null;
    expectedDate?: string | null;
    notes?: string | null;
    status?: string;
    createdBy?: number | null;
  }): Promise<any> {
    const ids = (data.purchaseRequirementIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new BadRequestException('purchaseRequirementIds is required');
    await this.vendorsService.findOne(data.vendorId);

    const status = data.status && PO_STATUSES.includes(data.status) ? data.status : 'SENT';

    const poId = await this.dataSource.transaction(async (em) => {
      const prs: any[] = await em.query(
        `SELECT * FROM purchase_requirements WHERE id = ANY($1::int[])`,
        [ids],
      );
      if (prs.length !== ids.length) {
        throw new BadRequestException('One or more purchase requirements were not found');
      }
      for (const pr of prs) {
        if (!['PENDING', 'APPROVED'].includes(pr.status)) {
          throw new BadRequestException(
            `PR #${pr.id} is ${pr.status} — only PENDING or APPROVED can be ordered`,
          );
        }
        if (pr.purchase_order_id) {
          throw new BadRequestException(`PR #${pr.id} is already linked to a purchase order`);
        }
      }

      // Group by item
      const byItem = new Map<number, { prIds: number[]; shortage: number }>();
      for (const pr of prs) {
        const iid = Number(pr.item_id);
        const g = byItem.get(iid) || { prIds: [], shortage: 0 };
        g.prIds.push(pr.id);
        g.shortage += Number(pr.shortage_qty);
        byItem.set(iid, g);
      }

      const lines: {
        itemId: number;
        itemSource: string;
        qty: number;
        rate: number;
        gstPercent: number;
        lineTotal: number;
        linkedPrIds: number[];
      }[] = [];

      for (const [itemId, g] of byItem) {
        const meta = await this.resolveItemMeta(itemId);
        const map = await this.vendorsService.resolveMapping(data.vendorId, itemId, meta.itemSource);
        if (!map) {
          throw new BadRequestException(
            `No vendor price mapping for item ${itemId} (${meta.itemSource}) — add a vendor mapping first`,
          );
        }
        let qty = g.shortage;
        const moq = Number(map.minimumOrderQty || 0);
        if (moq > 0 && qty < moq) qty = moq;
        const rate = Number(map.purchaseRate || 0);
        const net = qty * rate;
        const gstAmt = net * (Number(meta.gst) / 100);
        const lineTotal = net + gstAmt;
        lines.push({
          itemId,
          itemSource: meta.itemSource,
          qty,
          rate,
          gstPercent: meta.gst,
          lineTotal,
          linkedPrIds: g.prIds,
        });
      }

      let subtotal = 0;
      let gstAmount = 0;
      for (const ln of lines) {
        const net = ln.qty * ln.rate;
        subtotal += net;
        gstAmount += net * (ln.gstPercent / 100);
      }
      const totalAmount = subtotal + gstAmount;

      const poNumber = await this.nextPoNumber();
      const orderDate = new Date().toISOString().slice(0, 10);

      const poIns = await em.query(
        `INSERT INTO purchase_orders
          (po_number, vendor_id, warehouse_id, order_date, expected_date, status,
           subtotal, gst_amount, total_amount, notes, created_by)
         VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          poNumber,
          data.vendorId,
          data.warehouseId ?? null,
          orderDate,
          data.expectedDate ?? null,
          status,
          subtotal,
          gstAmount,
          totalAmount,
          data.notes ?? null,
          data.createdBy ?? null,
        ],
      );
      const poId = poIns[0].id;

      for (const ln of lines) {
        await em.query(
          `INSERT INTO purchase_order_items
            (purchase_order_id, item_id, item_source, qty, rate, gst_percent, line_total, received_qty, linked_pr_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8::jsonb)`,
          [
            poId,
            ln.itemId,
            ln.itemSource,
            ln.qty,
            ln.rate,
            ln.gstPercent,
            ln.lineTotal,
            JSON.stringify(ln.linkedPrIds),
          ],
        );
      }

      await em.query(
        `UPDATE purchase_requirements
         SET purchase_order_id = $1, po_number = $2, status = 'ORDERED', updated_at = now()
         WHERE id = ANY($3::int[])`,
        [poId, poNumber, ids],
      );

      this.logger.log(`Created PO ${poNumber} (${poId}) from ${ids.length} requirement(s)`);
      return poId;
    });
    this.eventEmitter.emit('purchase_order.updated', { purchaseOrderId: poId });
    return this.findOne(poId);
  }

  async updateHeader(id: number, data: { expectedDate?: string | null; notes?: string | null; status?: string }) {
    const po = await this.poRepo.findOneBy({ id });
    if (!po) throw new NotFoundException(`Purchase order ${id} not found`);
    if (data.expectedDate !== undefined) po.expectedDate = data.expectedDate;
    if (data.notes !== undefined) po.notes = data.notes ?? null;
    if (data.status !== undefined) {
      if (!PO_STATUSES.includes(data.status)) {
        throw new BadRequestException(`Invalid status: ${data.status}`);
      }
      po.status = data.status;
    }
    await this.poRepo.save(po);
    this.eventEmitter.emit('purchase_order.updated', { purchaseOrderId: id });
    return this.findOne(id);
  }

  /**
   * GRN — partial or full receive. Creates inventory_transactions (IN, PURCHASE_ORDER).
   */
  async receive(
    poId: number,
    body: {
      warehouseId?: number;
      lines: { purchaseOrderItemId: number; qty: number; warehouseId?: number }[];
    },
    userId?: number,
  ): Promise<any> {
    if (!body.lines?.length) throw new BadRequestException('lines is required');

    const out = await this.dataSource.transaction(async (em) => {
      const poRows = await em.query(`SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId]);
      if (!poRows.length) throw new NotFoundException(`Purchase order ${poId} not found`);
      const po = poRows[0];
      if (po.status === 'CANCELLED') throw new BadRequestException('Cannot receive on a cancelled PO');
      if (po.status === 'DRAFT') throw new BadRequestException('Send the PO before receiving (status is DRAFT)');

      const defaultWh = body.warehouseId ?? po.warehouse_id;
      if (!defaultWh) {
        throw new BadRequestException('warehouseId is required (set on PO or pass per receive)');
      }

      for (const ln of body.lines) {
        const qty = Number(ln.qty);
        if (!qty || qty <= 0) throw new BadRequestException('Each line needs qty > 0');
        const whId = ln.warehouseId ?? defaultWh;

        const [row] = await em.query(
          `SELECT * FROM purchase_order_items WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE`,
          [ln.purchaseOrderItemId, poId],
        );
        if (!row) throw new BadRequestException(`Invalid purchase order item ${ln.purchaseOrderItemId}`);
        const maxRecv = Number(row.qty) - Number(row.received_qty || 0);
        if (qty > maxRecv + 1e-6) {
          throw new BadRequestException(
            `Cannot receive ${qty} for item line ${row.id} — only ${maxRecv} remaining`,
          );
        }

        const [wh] = await em.query(`SELECT id FROM warehouses WHERE id = $1 AND active = true`, [whId]);
        if (!wh) throw new BadRequestException(`Warehouse ${whId} not found`);

        await em.query(
          `INSERT INTO inventory_transactions
             (item_id, warehouse_id, transaction_type, direction, qty, unit, rate, reference_type, reference_id, notes, created_by)
           VALUES ($1,$2,'PURCHASE_RECEIPT','IN',$3,'PCS',$4,'PURCHASE_ORDER',$5,$6,$7)`,
          [
            row.item_id,
            whId,
            qty,
            row.rate,
            poId,
            `GRN PO ${po.po_number} line ${row.id}`,
            userId ?? null,
          ],
        );

        await em.query(
          `UPDATE purchase_order_items SET received_qty = received_qty + $1 WHERE id = $2`,
          [qty, row.id],
        );

        await em.query(
          `UPDATE vendor_item_mappings
           SET last_purchase_rate = $1, updated_at = now()
           WHERE vendor_id = $2 AND item_id = $3 AND item_source = $4`,
          [row.rate, po.vendor_id, row.item_id, row.item_source],
        );
      }

      const sums = await em.query(
        `SELECT COALESCE(SUM(qty),0) AS t, COALESCE(SUM(received_qty),0) AS r
         FROM purchase_order_items WHERE purchase_order_id = $1`,
        [poId],
      );
      const t = Number(sums[0]?.t ?? 0);
      const r = Number(sums[0]?.r ?? 0);
      let newStatus = po.status;
      if (r <= 1e-6) newStatus = 'SENT';
      else if (r >= t - 1e-6) newStatus = 'RECEIVED';
      else newStatus = 'PARTIAL_RECEIVED';

      await em.query(
        `UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2`,
        [newStatus, poId],
      );

      return this.findOne(poId);
    });
    this.eventEmitter.emit('purchase_order.updated', { purchaseOrderId: poId });
    return out;
  }
}

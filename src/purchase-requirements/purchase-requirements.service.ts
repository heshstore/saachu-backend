import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { PurchaseRequirement } from './entities/purchase-requirement.entity';

const VALID_STATUSES = ['PENDING', 'APPROVED', 'ORDERED', 'CANCELLED'];
const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

@Injectable()
export class PurchaseRequirementsService {
  private readonly logger = new Logger(PurchaseRequirementsService.name);

  constructor(
    @InjectRepository(PurchaseRequirement)
    private readonly repo: Repository<PurchaseRequirement>,
    private readonly dataSource: DataSource,
  ) {}

  // ── Event listener — fires after OrderExplosionService completes ──────────────

  @OnEvent('order.exploded')
  async onOrderExploded(payload: { orderId: number }): Promise<void> {
    try {
      await this.generateForOrder(payload.orderId);
    } catch (err: any) {
      this.logger.warn(
        `[PurchaseReq] Failed to generate requirements for order ${payload.orderId}: ${err?.message}`,
      );
    }
  }

  // ── Core shortage detection ───────────────────────────────────────────────────

  /**
   * Idempotent: wipes all existing ORDER-sourced requirements for this orderId,
   * then re-computes from order_material_requirements.
   * Only MANUFACTURING items with an ACTIVE BOQ appear in order_material_requirements,
   * so TRADING/SERVICE items are automatically skipped.
   */
  async generateForOrder(orderId: number): Promise<void> {
    this.logger.log(
      `[PurchaseReq] Generating requirements for order ${orderId}…`,
    );

    // Read the exploded material requirements for this order
    const materialReqs: any[] = await this.dataSource.query(
      `SELECT
         omr.raw_material_item_id  AS "itemId",
         SUM(omr.calculated_qty)   AS "totalRequired",
         omr.consumption_type      AS "unit",
         si.stock_tracking_type    AS "stockUnit",
         si.item_name              AS "itemName"
       FROM order_material_requirements omr
       LEFT JOIN service_items si ON si.id = omr.raw_material_item_id
       WHERE omr.order_id = $1
       GROUP BY omr.raw_material_item_id, omr.consumption_type, si.stock_tracking_type, si.item_name`,
      [orderId],
    );

    if (!materialReqs.length) {
      // No MANUFACTURING items or no BOQ — nothing to generate; clear stale rows
      await this.dataSource.query(
        `DELETE FROM purchase_requirements WHERE source_type = 'ORDER' AND source_id = $1`,
        [orderId],
      );
      this.logger.debug(
        `[PurchaseReq] Order ${orderId}: no material requirements — cleared stale rows`,
      );
      return;
    }

    // Calculate available stock for each unique raw material item across all warehouses
    const itemIds = [...new Set(materialReqs.map((r) => r.itemId))];
    const stockMap = await this.getStockMap(itemIds);

    // Wipe old requirements for this order before re-inserting
    await this.dataSource.query(
      `DELETE FROM purchase_requirements WHERE source_type = 'ORDER' AND source_id = $1`,
      [orderId],
    );

    let created = 0;
    let skipped = 0;

    for (const req of materialReqs) {
      const requiredQty = Number(req.totalRequired);
      const availableQty = stockMap.get(req.itemId) ?? 0;
      const shortageQty = requiredQty - availableQty;

      if (shortageQty <= 0) {
        this.logger.debug(
          `[PurchaseReq] Order ${orderId}: item ${req.itemId} (${req.itemName}) — stock sufficient ` +
            `(required ${requiredQty}, available ${availableQty}) — no requirement created`,
        );
        skipped++;
        continue;
      }

      const unit = req.stockUnit || req.unit || 'PCS';

      // Determine priority based on shortage severity
      const shortage_pct =
        availableQty > 0 ? (shortageQty / requiredQty) * 100 : 100;
      const priority =
        shortage_pct >= 100 ? 'HIGH' : shortage_pct >= 50 ? 'MEDIUM' : 'LOW';

      await this.dataSource.query(
        `INSERT INTO purchase_requirements
           (item_id, warehouse_id, source_type, source_id, required_qty, available_qty,
            shortage_qty, unit, status, priority, notes, created_by, created_at, updated_at)
         VALUES ($1, NULL, 'ORDER', $2, $3, $4, $5, $6, 'PENDING', $7, NULL, NULL, now(), now())`,
        [
          req.itemId,
          orderId,
          requiredQty,
          availableQty,
          shortageQty,
          unit,
          priority,
        ],
      );
      created++;
    }

    this.logger.log(
      `[PurchaseReq] Order ${orderId}: ${created} requirement(s) created, ${skipped} skipped (stock sufficient)`,
    );
  }

  // ── Stock lookup — SUM(IN) - SUM(OUT) across all warehouses ──────────────────

  private async getStockMap(itemIds: number[]): Promise<Map<number, number>> {
    if (!itemIds.length) return new Map();

    const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
    const rows: any[] = await this.dataSource.query(
      `SELECT
         item_id,
         COALESCE(SUM(CASE WHEN direction = 'IN'  THEN qty ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN direction = 'OUT' THEN qty ELSE 0 END), 0) AS "currentStock"
       FROM inventory_transactions
       WHERE item_id IN (${placeholders})
       GROUP BY item_id`,
      itemIds,
    );

    const map = new Map<number, number>();
    for (const r of rows) map.set(Number(r.item_id), Number(r.currentStock));
    // Items with no transactions default to 0
    for (const id of itemIds) if (!map.has(id)) map.set(id, 0);
    return map;
  }

  // ── Query API ─────────────────────────────────────────────────────────────────

  async findAll(
    filters: {
      status?: string;
      priority?: string;
      itemId?: number;
      sourceId?: number;
    } = {},
  ): Promise<any[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`pr.status   = $${params.length}`);
    }
    if (filters.priority) {
      params.push(filters.priority);
      conditions.push(`pr.priority = $${params.length}`);
    }
    if (filters.itemId) {
      params.push(filters.itemId);
      conditions.push(`pr.item_id  = $${params.length}`);
    }
    if (filters.sourceId) {
      params.push(filters.sourceId);
      conditions.push(`pr.source_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.dataSource.query(
      `SELECT
         pr.*,
         COALESCE(si.item_name, sci.item_name)     AS "itemName",
         COALESCE(si.item_code, sci.item_code)     AS "itemCode",
         COALESCE(si.sku, sci.sku)                 AS "itemSku",
         si.main_category_type                     AS "categoryType",
         w.name                                    AS "warehouseName",
         w.code                                    AS "warehouseCode",
         o.order_no                                AS "orderNo",
         o.customer_name                           AS "customerName"
       FROM purchase_requirements pr
       LEFT JOIN service_items si         ON si.id  = pr.item_id
       LEFT JOIN shopify_catalog_items sci ON sci.id = pr.item_id
       LEFT JOIN warehouses w             ON w.id   = pr.warehouse_id
       LEFT JOIN orders o                ON o.id   = pr.source_id AND pr.source_type = 'ORDER'
       ${where}
       ORDER BY
         CASE pr.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         pr.created_at DESC`,
      params,
    );
  }

  async findOne(id: number): Promise<any> {
    const rows = await this.dataSource.query(
      `SELECT
         pr.*,
         COALESCE(si.item_name, sci.item_name)     AS "itemName",
         COALESCE(si.item_code, sci.item_code)     AS "itemCode",
         COALESCE(si.sku, sci.sku)                 AS "itemSku",
         si.main_category_type                     AS "categoryType",
         w.name                                    AS "warehouseName",
         w.code                                    AS "warehouseCode",
         o.order_no                                AS "orderNo",
         o.customer_name                           AS "customerName",
         o.status                                  AS "orderStatus"
       FROM purchase_requirements pr
       LEFT JOIN service_items si          ON si.id  = pr.item_id
       LEFT JOIN shopify_catalog_items sci ON sci.id = pr.item_id
       LEFT JOIN warehouses w              ON w.id   = pr.warehouse_id
       LEFT JOIN orders o                 ON o.id   = pr.source_id AND pr.source_type = 'ORDER'
       WHERE pr.id = $1`,
      [id],
    );
    if (!rows.length)
      throw new NotFoundException(`Purchase requirement ${id} not found`);
    return rows[0];
  }

  async update(
    id: number,
    data: {
      status?: string;
      priority?: string;
      notes?: string;
    },
  ): Promise<any> {
    const req = await this.repo.findOneBy({ id });
    if (!req)
      throw new NotFoundException(`Purchase requirement ${id} not found`);

    if (data.status !== undefined) {
      if (!VALID_STATUSES.includes(data.status))
        throw new BadRequestException(
          `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        );
      req.status = data.status;
    }
    if (data.priority !== undefined) {
      if (!VALID_PRIORITIES.includes(data.priority))
        throw new BadRequestException(
          `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
        );
      req.priority = data.priority;
    }
    if (data.notes !== undefined) req.notes = data.notes ?? null;

    await this.repo.save(req);
    return this.findOne(id);
  }

  // ── Manual trigger — for re-running shortage check on demand ─────────────────

  async regenerateForOrder(orderId: number): Promise<{ message: string }> {
    await this.generateForOrder(orderId);
    return {
      message: `Purchase requirements regenerated for order ${orderId}`,
    };
  }

  // ── Summary stats ─────────────────────────────────────────────────────────────

  async getSummaryStats(): Promise<any> {
    const rows = await this.dataSource.query(`
      SELECT
        status,
        priority,
        COUNT(*)                          AS count,
        SUM(shortage_qty)                 AS total_shortage
      FROM purchase_requirements
      GROUP BY status, priority
      ORDER BY status, priority
    `);
    return rows;
  }
}

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Warehouse } from './entities/warehouse.entity';
import { InventoryTransaction } from './entities/inventory-transaction.entity';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Warehouse)
    private readonly warehouseRepo: Repository<Warehouse>,

    @InjectRepository(InventoryTransaction)
    private readonly txRepo: Repository<InventoryTransaction>,

    private readonly dataSource: DataSource,
  ) {}

  // ── Warehouse CRUD ────────────────────────────────────────────────────────────

  findAllWarehouses(includeInactive = false): Promise<Warehouse[]> {
    if (includeInactive)
      return this.warehouseRepo.find({ order: { name: 'ASC' } });
    return this.warehouseRepo.find({
      where: { active: true },
      order: { name: 'ASC' },
    });
  }

  async createWarehouse(data: any): Promise<Warehouse> {
    if (!data.name?.trim())
      throw new BadRequestException('Warehouse name is required');
    if (!data.code?.trim())
      throw new BadRequestException('Warehouse code is required');
    const wh = this.warehouseRepo.create({
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      type: data.type ?? 'GENERAL',
      active: data.active !== false,
    });
    return this.warehouseRepo.save(wh);
  }

  async updateWarehouse(id: number, data: any): Promise<Warehouse> {
    const wh = await this.warehouseRepo.findOneBy({ id });
    if (!wh) throw new NotFoundException(`Warehouse ${id} not found`);
    if (data.name !== undefined) wh.name = data.name.trim();
    if (data.code !== undefined) wh.code = data.code.trim().toUpperCase();
    if (data.type !== undefined) wh.type = data.type;
    if (data.active !== undefined) wh.active = Boolean(data.active);
    return this.warehouseRepo.save(wh);
  }

  // ── Transaction Entry ─────────────────────────────────────────────────────────

  async createTransaction(
    data: any,
    userId?: number,
  ): Promise<InventoryTransaction> {
    // Validate required fields
    if (!data.itemId) throw new BadRequestException('itemId is required');
    if (!data.warehouseId)
      throw new BadRequestException('warehouseId is required');
    if (!data.transactionType)
      throw new BadRequestException('transactionType is required');
    if (!data.direction) throw new BadRequestException('direction is required');

    const qty = Number(data.qty);
    if (!qty || qty <= 0) throw new BadRequestException('qty must be > 0');

    const VALID_DIRECTIONS = ['IN', 'OUT', 'ADJUSTMENT'];
    if (!VALID_DIRECTIONS.includes(data.direction)) {
      throw new BadRequestException(
        `direction must be one of: ${VALID_DIRECTIONS.join(', ')}`,
      );
    }

    // Verify warehouse exists
    const wh = await this.warehouseRepo.findOneBy({
      id: Number(data.warehouseId),
    });
    if (!wh)
      throw new NotFoundException(`Warehouse ${data.warehouseId} not found`);

    // Verify item exists in service_items or shopify_catalog_items
    const itemRows = await this.dataSource.query(
      `SELECT id FROM service_items WHERE id = $1
       UNION ALL
       SELECT id FROM shopify_catalog_items WHERE id = $1
       LIMIT 1`,
      [Number(data.itemId)],
    );
    if (!itemRows.length)
      throw new NotFoundException(`Item ${data.itemId} not found`);

    const tx = this.txRepo.create({
      itemId: Number(data.itemId),
      warehouseId: Number(data.warehouseId),
      transactionType: data.transactionType,
      direction: data.direction,
      qty,
      unit: data.unit ?? 'PCS',
      rate: data.rate != null ? Number(data.rate) : null,
      referenceType: data.referenceType ?? null,
      referenceId: data.referenceId ? Number(data.referenceId) : null,
      notes: data.notes ?? null,
      createdBy: userId ?? null,
    });
    return this.txRepo.save(tx);
  }

  // ── Inventory Summary ─────────────────────────────────────────────────────────

  async getSummary(): Promise<any[]> {
    // Aggregate stock per item × warehouse
    const rows: any[] = await this.dataSource.query(`
      SELECT
        t.item_id                                                   AS "itemId",
        t.warehouse_id                                              AS "warehouseId",
        w.name                                                      AS "warehouseName",
        w.code                                                      AS "warehouseCode",
        w.type                                                      AS "warehouseType",
        t.unit,
        COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty ELSE 0 END), 0) AS "totalIn",
        COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.qty ELSE 0 END), 0) AS "totalOut",
        COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.qty ELSE 0 END), 0) AS "currentStock"
      FROM inventory_transactions t
      JOIN warehouses w ON w.id = t.warehouse_id
      GROUP BY t.item_id, t.warehouse_id, w.name, w.code, w.type, t.unit
      ORDER BY t.item_id, w.name
    `);

    if (!rows.length) return [];

    // Enrich with item names — look up service_items first, fallback to shopify_catalog_items
    const itemIds: number[] = [...new Set(rows.map((r) => r.itemId))];
    const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');

    const svcItems: any[] = await this.dataSource.query(
      `SELECT id, item_name AS "itemName", item_code AS "itemCode",
              stock_tracking_type AS "unit", main_category_type AS "categoryType"
       FROM service_items WHERE id IN (${placeholders})`,
      itemIds,
    );
    const shopItems: any[] = await this.dataSource.query(
      `SELECT id, item_name AS "itemName", item_code AS "itemCode",
              unit, main_category_type AS "categoryType"
       FROM shopify_catalog_items WHERE id IN (${placeholders})`,
      itemIds,
    );

    const itemMap = new Map<number, any>();
    for (const i of [...svcItems, ...shopItems]) itemMap.set(i.id, i);

    // Group by item — each item can span multiple warehouses
    const byItem = new Map<number, any>();
    for (const r of rows) {
      const meta = itemMap.get(r.itemId) ?? {
        itemName: `Item #${r.itemId}`,
        itemCode: '',
        categoryType: null,
      };
      if (!byItem.has(r.itemId)) {
        byItem.set(r.itemId, {
          itemId: r.itemId,
          itemName: meta.itemName,
          itemCode: meta.itemCode,
          categoryType: meta.categoryType,
          unit: r.unit,
          totalIn: 0,
          totalOut: 0,
          currentStock: 0,
          warehouses: [],
        });
      }
      const item = byItem.get(r.itemId)!;
      item.totalIn += Number(r.totalIn);
      item.totalOut += Number(r.totalOut);
      item.currentStock += Number(r.currentStock);
      item.warehouses.push({
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        warehouseCode: r.warehouseCode,
        warehouseType: r.warehouseType,
        totalIn: Number(r.totalIn),
        totalOut: Number(r.totalOut),
        currentStock: Number(r.currentStock),
      });
    }

    return [...byItem.values()];
  }

  // ── Item Ledger ───────────────────────────────────────────────────────────────

  async getItemLedger(itemId: number): Promise<any> {
    // Verify item exists
    const svcRows = await this.dataSource.query(
      `SELECT id, item_name AS "itemName", item_code AS "itemCode",
              stock_tracking_type AS "unit", main_category_type AS "categoryType"
       FROM service_items WHERE id = $1`,
      [itemId],
    );
    const shopRows = await this.dataSource.query(
      `SELECT id, item_name AS "itemName", item_code AS "itemCode",
              unit, main_category_type AS "categoryType"
       FROM shopify_catalog_items WHERE id = $1`,
      [itemId],
    );
    const itemMeta = svcRows[0] ?? shopRows[0];
    if (!itemMeta) throw new NotFoundException(`Item ${itemId} not found`);

    // Transactions in chronological order
    const txRows: any[] = await this.dataSource.query(
      `
      SELECT
        t.id,
        t.transaction_type  AS "transactionType",
        t.direction,
        t.qty,
        t.unit,
        t.rate,
        t.reference_type    AS "referenceType",
        t.reference_id      AS "referenceId",
        t.notes,
        t.created_by        AS "createdBy",
        t.created_at        AS "createdAt",
        w.id                AS "warehouseId",
        w.name              AS "warehouseName",
        w.code              AS "warehouseCode"
      FROM inventory_transactions t
      JOIN warehouses w ON w.id = t.warehouse_id
      WHERE t.item_id = $1
      ORDER BY t.created_at ASC, t.id ASC
    `,
      [itemId],
    );

    // Warehouse balances
    const balRows: any[] = await this.dataSource.query(
      `
      SELECT
        w.id                AS "warehouseId",
        w.name              AS "warehouseName",
        w.code              AS "warehouseCode",
        w.type              AS "warehouseType",
        t.unit,
        COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty ELSE 0 END), 0) AS "totalIn",
        COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.qty ELSE 0 END), 0) AS "totalOut",
        COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.qty ELSE 0 END), 0) AS "currentStock"
      FROM inventory_transactions t
      JOIN warehouses w ON w.id = t.warehouse_id
      WHERE t.item_id = $1
      GROUP BY w.id, w.name, w.code, w.type, t.unit
      ORDER BY w.name
    `,
      [itemId],
    );

    const totalStock = balRows.reduce((s, r) => s + Number(r.currentStock), 0);

    return {
      item: itemMeta,
      totalStock,
      warehouses: balRows,
      transactions: txRows,
    };
  }

  // ── Transactions List (for admin / audit) ─────────────────────────────────────

  async getTransactions(limit = 100, offset = 0): Promise<any[]> {
    return this.dataSource.query(
      `
      SELECT
        t.*,
        w.name AS "warehouseName",
        w.code AS "warehouseCode"
      FROM inventory_transactions t
      JOIN warehouses w ON w.id = t.warehouse_id
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $1 OFFSET $2
    `,
      [limit, offset],
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class OrderExplosionService {
  private readonly logger = new Logger(OrderExplosionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Idempotent: deletes all existing rows for the order then re-explodes from
   * the active BOQ.  Safe to call on every create/update.
   *
   * Only MANUFACTURING items with an ACTIVE BOQ are processed.
   * Trading and service items are silently skipped.
   */
  async explode(orderId: number): Promise<void> {
    try {
      // Fetch all order items (column is "orderId" — camelCase in DB)
      const orderItems: any[] = await this.dataSource.query(
        `SELECT id, sku, item_name, qty FROM order_item WHERE "orderId" = $1`,
        [orderId],
      );

      // Wipe existing planning rows — idempotent reset
      await this.dataSource.query(
        `DELETE FROM order_material_requirements WHERE order_id = $1`,
        [orderId],
      );
      await this.dataSource.query(
        `DELETE FROM department_workloads WHERE order_id = $1`,
        [orderId],
      );

      for (const oi of orderItems) {
        if (!oi.sku) continue;

        // Look up the service item — must be MANUFACTURING
        const svcRows: any[] = await this.dataSource.query(
          `SELECT id, main_category_type FROM service_items WHERE sku = $1 AND is_active = true LIMIT 1`,
          [oi.sku],
        );
        if (
          !svcRows.length ||
          svcRows[0].main_category_type !== 'MANUFACTURING'
        )
          continue;

        const svcItem = svcRows[0];

        // Get the newest ACTIVE BOQ for this item
        const boqRows: any[] = await this.dataSource.query(
          `SELECT id FROM manufacturing_boqs WHERE item_id = $1 AND status = 'ACTIVE'
           ORDER BY version DESC LIMIT 1`,
          [svcItem.id],
        );
        if (!boqRows.length) {
          this.logger.debug(
            `[Explosion] Order ${orderId}: item SKU "${oi.sku}" is MANUFACTURING but has no ACTIVE BOQ — skipping`,
          );
          continue;
        }

        const boqId = boqRows[0].id;
        const lines: any[] = await this.dataSource.query(
          `SELECT * FROM manufacturing_boq_items WHERE boq_id = $1`,
          [boqId],
        );

        const orderedQty = Number(oi.qty) || 1;

        for (const line of lines) {
          const qtyPerUnit = Number(line.qty_per_unit);
          const wastagePercent = Number(line.wastage_percent) || 0;
          const requiredQty = qtyPerUnit * orderedQty;
          const calculatedQty = requiredQty * (1 + wastagePercent / 100);

          await this.dataSource.query(
            `INSERT INTO order_material_requirements
               (order_id, order_item_id, item_id, raw_material_item_id, boq_item_id,
                required_qty, consumption_type, wastage_percent, calculated_qty, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',now())`,
            [
              orderId,
              oi.id,
              svcItem.id,
              line.raw_material_item_id,
              line.id,
              requiredQty,
              line.consumption_type,
              wastagePercent,
              calculatedQty,
            ],
          );

          await this.dataSource.query(
            `INSERT INTO department_workloads
               (order_id, order_item_id, department_id, boq_item_id,
                workload_qty, workload_unit, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,'PENDING',now())`,
            [
              orderId,
              oi.id,
              line.department_id,
              line.id,
              calculatedQty,
              line.consumption_type,
            ],
          );
        }
      }

      this.logger.debug(`[Explosion] Order ${orderId} exploded successfully`);

      // Notify PurchaseRequirementsService to run shortage detection
      this.eventEmitter.emit('order.exploded', { orderId });
    } catch (err: any) {
      // Non-fatal — planning data is best-effort
      this.logger.warn(`[Explosion] Order ${orderId} failed: ${err?.message}`);
    }
  }

  /** Planning API — material requirements with raw material details */
  async getRequirements(orderId: number): Promise<any[]> {
    return this.dataSource.query(
      `SELECT
         omr.id, omr.order_item_id, omr.boq_item_id,
         omr.required_qty, omr.consumption_type, omr.wastage_percent,
         omr.calculated_qty, omr.status, omr.notes,
         si_rm.item_name  AS raw_material_name,
         si_rm.sku        AS raw_material_sku,
         si_rm.unit       AS raw_material_unit,
         si_fi.item_name  AS finished_item_name,
         si_fi.sku        AS finished_item_sku,
         oi.item_name     AS order_item_name,
         oi.qty           AS order_item_qty
       FROM order_material_requirements omr
       LEFT JOIN service_items si_rm ON si_rm.id = omr.raw_material_item_id
       LEFT JOIN service_items si_fi ON si_fi.id = omr.item_id
       LEFT JOIN order_item oi       ON oi.id     = omr.order_item_id
       WHERE omr.order_id = $1
       ORDER BY omr.id`,
      [orderId],
    );
  }

  /** Planning API — department workloads with department details */
  async getWorkloads(orderId: number): Promise<any[]> {
    return this.dataSource.query(
      `SELECT
         dw.id, dw.order_item_id, dw.boq_item_id,
         dw.workload_qty, dw.workload_unit, dw.estimated_hours, dw.status,
         d.name AS department_name,
         d.code AS department_code,
         oi.item_name AS order_item_name,
         oi.qty        AS order_item_qty
       FROM department_workloads dw
       LEFT JOIN departments d ON d.id = dw.department_id
       LEFT JOIN order_item oi ON oi.id = dw.order_item_id
       WHERE dw.order_id = $1
       ORDER BY dw.id`,
      [orderId],
    );
  }
}

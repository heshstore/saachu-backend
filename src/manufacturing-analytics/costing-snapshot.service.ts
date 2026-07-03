import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { ProductionCostSnapshot } from './entities/production-cost-snapshot.entity';

const EPS = 1e-6;

/** Builds immutable production_cost_snapshots from ledger + master data only */
@Injectable()
export class CostingSnapshotService {
  private readonly logger = new Logger(CostingSnapshotService.name);

  constructor(
    @InjectRepository(ProductionCostSnapshot)
    private readonly snapRepo: Repository<ProductionCostSnapshot>,
    private readonly dataSource: DataSource,
  ) {}

  @OnEvent('production.job.completed', { async: true })
  async onJobCompleted(payload: { jobId: number }): Promise<void> {
    try {
      await this.ensureSnapshotForJob(payload.jobId);
    } catch (err: any) {
      this.logger.warn(
        `[CostingSnapshot] Failed for job ${payload.jobId}: ${err?.message ?? err}`,
      );
    }
  }

  /** Idempotent: inserts one row per production_job_id; never updates existing */
  async ensureSnapshotForJob(
    jobId: number,
  ): Promise<ProductionCostSnapshot | null> {
    const existing = await this.snapRepo.count({
      where: { productionJobId: jobId },
    });
    if (existing > 0) return null;

    const jobs: any[] = await this.dataSource.query(
      `SELECT id, order_id, order_item_id, item_id, qty::float AS qty,
              completed_qty::float AS completed_qty, rejected_qty::float AS rejected_qty,
              status
       FROM production_execution_jobs WHERE id = $1`,
      [jobId],
    );
    if (!jobs.length || jobs[0].status !== 'COMPLETED') return null;

    const j = jobs[0];
    const orderId = Number(j.order_id);
    const itemId = Number(j.item_id);
    const producedQty = Number(j.completed_qty) || 0;
    const rejectedQty = Number(j.rejected_qty) || 0;
    const jobQty = Number(j.qty) || 0;

    if (producedQty <= EPS) {
      this.logger.warn(
        `[CostingSnapshot] Job ${jobId}: skip snapshot — producedQty is 0`,
      );
      return null;
    }

    const rawMaterialCost = await this.sumConsumptionValue(jobId);
    const productionCost = await this.sumLabourCostForJob(jobId);
    const plannedMaterialAtJob =
      await this.plannedReservationMaterialValue(jobId);
    const baselineGood =
      jobQty > EPS
        ? plannedMaterialAtJob * (producedQty / jobQty)
        : plannedMaterialAtJob;
    const wastageCost = Math.max(0, rawMaterialCost - baselineGood);

    const dispatchRows: any[] = await this.dataSource.query(
      `SELECT COALESCE(SUM(
           COALESCE(packing_cost,0) + COALESCE(logistics_cost,0) + COALESCE(misc_cost,0)
         ), 0)::float AS s
       FROM dispatch_orders
       WHERE order_id = $1
         AND status NOT IN ('DRAFT','CANCELLED')`,
      [orderId],
    );
    const dispatchCost = Number(dispatchRows[0]?.s) || 0;

    const totalCost =
      rawMaterialCost + productionCost + wastageCost + dispatchCost;
    const costPerUnit = producedQty > EPS ? totalCost / producedQty : 0;

    const row = this.snapRepo.create({
      orderId,
      productionJobId: jobId,
      itemId,
      rawMaterialCost,
      productionCost,
      wastageCost,
      dispatchCost,
      totalCost,
      costPerUnit,
      producedQty,
      rejectedQty,
    });

    try {
      return await this.snapRepo.save(row);
    } catch (err: any) {
      if (String(err?.code) === '23505') return null;
      throw err;
    }
  }

  /** Backfill snapshots for completed jobs missing a row (read-only on ledger) */
  async backfillMissingSnapshots(
    limit = 100,
  ): Promise<{ scanned: number; snapshotsCreated: number }> {
    const lim = Math.min(500, Math.max(1, limit));
    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM production_execution_jobs
       WHERE status = 'COMPLETED'
         AND id NOT IN (SELECT production_job_id FROM production_cost_snapshots)
       ORDER BY completed_at DESC NULLS LAST
       LIMIT $1`,
      [lim],
    );
    let created = 0;
    for (const r of rows) {
      const s = await this.ensureSnapshotForJob(r.id);
      if (s) created += 1;
    }
    return { scanned: rows.length, snapshotsCreated: created };
  }

  /** Sum(qty * rate) for PRODUCTION_CONSUMPTION; missing tx rate → latest inward rate */
  private async sumConsumptionValue(jobId: number): Promise<number> {
    const rows: any[] = await this.dataSource.query(
      `
      WITH latest_in AS (
        SELECT DISTINCT ON (item_id)
          item_id,
          rate
        FROM inventory_transactions
        WHERE direction = 'IN'
          AND COALESCE(rate, 0) > 0
          AND transaction_type = ANY (ARRAY['PURCHASE_RECEIPT','OPENING_STOCK','FG_PRODUCTION_IN']::text[])
        ORDER BY item_id, created_at DESC
      )
      SELECT COALESCE(SUM(
        t.qty * COALESCE(NULLIF(t.rate, 0), li.rate, si.cost_price, 0)
      ), 0)::float AS v
      FROM inventory_transactions t
      LEFT JOIN latest_in li ON li.item_id = t.item_id
      LEFT JOIN service_items si ON si.id = t.item_id
      WHERE t.reference_type = 'PRODUCTION_JOB'
        AND t.reference_id = $1
        AND t.transaction_type = 'PRODUCTION_CONSUMPTION'
        AND t.direction = 'OUT'
      `,
      [jobId],
    );
    return Number(rows[0]?.v) || 0;
  }

  private async plannedReservationMaterialValue(
    jobId: number,
  ): Promise<number> {
    const rows: any[] = await this.dataSource.query(
      `
      SELECT COALESCE(SUM(
        pmr.required_qty * COALESCE(NULLIF(pmr.planned_rate, 0), si.cost_price, 0)
      ), 0)::float AS v
      FROM production_material_reservations pmr
      JOIN service_items si ON si.id = pmr.raw_material_item_id
      WHERE pmr.production_job_id = $1
        AND pmr.status <> 'CANCELLED'
      `,
      [jobId],
    );
    return Number(rows[0]?.v) || 0;
  }

  private async sumLabourCostForJob(jobId: number): Promise<number> {
    const rows: any[] = await this.dataSource.query(
      `
      SELECT COALESCE(SUM(
        (COALESCE(pjs.actual_working_minutes, 0) / 60.0) *
        (COALESCE(dcm.cost_per_hour, 0) + COALESCE(dcm.manpower_rate, 0) + COALESCE(dcm.overhead_rate, 0))
      ), 0)::float AS v
      FROM production_job_stages pjs
      LEFT JOIN department_cost_master dcm
        ON dcm.department_id = pjs.department_id AND dcm.active = true
      WHERE pjs.production_job_id = $1
        AND pjs.status = 'COMPLETED'
      `,
      [jobId],
    );
    return Number(rows[0]?.v) || 0;
  }
}

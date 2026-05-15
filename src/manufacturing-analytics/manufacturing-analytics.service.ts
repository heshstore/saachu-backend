import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DepartmentCostMaster } from './entities/department-cost-master.entity';
import { ProductionCostSnapshot } from './entities/production-cost-snapshot.entity';

const EPS = 1e-6;

@Injectable()
export class ManufacturingAnalyticsService {
  private readonly logger = new Logger(ManufacturingAnalyticsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(DepartmentCostMaster)
    private readonly deptCostRepo: Repository<DepartmentCostMaster>,
    @InjectRepository(ProductionCostSnapshot)
    private readonly snapRepo: Repository<ProductionCostSnapshot>,
  ) {}

  async listDepartmentCosts(): Promise<DepartmentCostMaster[]> {
    return this.deptCostRepo.find({ order: { departmentId: 'ASC' as const } });
  }

  async upsertDepartmentCost(
    departmentId: number,
    body: { costPerHour?: number; manpowerRate?: number; overheadRate?: number; active?: boolean },
  ): Promise<DepartmentCostMaster> {
    let row = await this.deptCostRepo.findOne({ where: { departmentId } });
    if (!row) {
      row = this.deptCostRepo.create({
        departmentId,
        costPerHour:     body.costPerHour ?? 0,
        manpowerRate:    body.manpowerRate ?? 0,
        overheadRate:    body.overheadRate ?? 0,
        active:          body.active ?? true,
      });
    } else {
      if (body.costPerHour !== undefined) row.costPerHour = body.costPerHour;
      if (body.manpowerRate !== undefined) row.manpowerRate = body.manpowerRate;
      if (body.overheadRate !== undefined) row.overheadRate = body.overheadRate;
      if (body.active !== undefined) row.active = body.active;
    }
    return this.deptCostRepo.save(row);
  }

  /** Dashboard / BI — read-only aggregates */
  async getIntelSummary(): Promise<{
    wip_order_value: number;
    delayed_execution_hints: number;
    pending_dispatch_value: number;
    procurement_exposure: number;
    fg_stock_value: number;
    active_execution_jobs: number;
    loss_making_orders: number;
    production_efficiency_pct: number;
  }> {
    try {
      const [
        wip,
        delayed,
        pendingDispatch,
        procurementExp,
        fgVal,
        execActive,
        lossOrders,
      ] = await Promise.all([
        this.dataSource.query(`
          SELECT COALESCE(SUM(total_amount), 0)::float AS v
          FROM orders WHERE status = 'IN_PRODUCTION'
        `),
        this.dataSource.query(`
          SELECT COUNT(DISTINCT ej.id)::int AS c
          FROM production_execution_jobs ej
          JOIN production_job_stages pjs ON pjs.production_job_id = ej.id
          WHERE ej.status IN ('PENDING','READY','IN_PROGRESS','HOLD')
            AND pjs.status IN ('WORKING','READY','STOPPED','ON_HOLD')
            AND pjs.started_at IS NOT NULL
            AND pjs.completed_at IS NULL
            AND pjs.started_at < now() - interval '48 hours'
        `),
        this.dataSource.query(`
          SELECT COALESCE(SUM(oi.amount::float), 0)::float AS v
          FROM order_item oi
          JOIN orders o ON o.id = oi."orderId"
          WHERE o.status IN ('READY','READY_FOR_DISPATCH','PARTIAL_DISPATCHED','PARTIAL_DELIVERED')
        `),
        this.dataSource.query(`
          SELECT COALESCE(SUM(pr.shortage_qty * COALESCE(si.cost_price, 0)), 0)::float AS v
          FROM purchase_requirements pr
          LEFT JOIN service_items si ON si.id = pr.item_id
          WHERE pr.status IN ('PENDING','APPROVED')
            AND COALESCE(pr.shortage_qty, 0) > 0
        `),
        this.dataSource.query(`
          WITH bal AS (
            SELECT t.item_id,
              SUM(CASE WHEN t.direction = 'IN' THEN t.qty WHEN t.direction = 'OUT' THEN -t.qty ELSE 0 END)::float AS q
            FROM inventory_transactions t
            GROUP BY t.item_id
            HAVING SUM(CASE WHEN t.direction = 'IN' THEN t.qty WHEN t.direction = 'OUT' THEN -t.qty ELSE 0 END) > $1
          )
          SELECT COALESCE(SUM(bal.q * COALESCE(si.cost_price, 0)), 0)::float AS v
          FROM bal
          JOIN service_items si ON si.id = bal.item_id
        `, [EPS]),
        this.dataSource.query(`
          SELECT COUNT(*)::int AS c FROM production_execution_jobs
          WHERE status IN ('PENDING','READY','IN_PROGRESS','HOLD')
        `),
        this.dataSource.query(`
          SELECT COUNT(*)::int AS c
          FROM (
            SELECT o.id,
              o.total_amount::float
              - COALESCE((
                  SELECT SUM(pcs.raw_material_cost + pcs.production_cost + pcs.wastage_cost)
                  FROM production_cost_snapshots pcs WHERE pcs.order_id = o.id
                ), 0)
              - COALESCE((
                  SELECT SUM(COALESCE(d.packing_cost,0)+COALESCE(d.logistics_cost,0)+COALESCE(d.misc_cost,0))
                  FROM dispatch_orders d
                  WHERE d.order_id = o.id AND d.status NOT IN ('DRAFT','CANCELLED')
                ), 0) AS gp
            FROM orders o
            WHERE o.status NOT IN ('CANCELLED','REJECTED')
          ) x WHERE x.gp < 0
        `),
      ]);

      const wipVal = Number(wip[0]?.v) || 0;
      const fgStockValue = Number(fgVal[0]?.v) || 0;
      const plannedMinutes = await this.dataSource.query(`
        SELECT COALESCE(SUM(pjs.planned_qty * 15), 0)::float AS v
        FROM production_job_stages pjs
        JOIN production_execution_jobs ej ON ej.id = pjs.production_job_id
        WHERE ej.status IN ('IN_PROGRESS','HOLD','READY','PENDING')
          AND pjs.status IN ('WORKING','READY','STOPPED','ON_HOLD')
      `);
      const workedMinutes = await this.dataSource.query(`
        SELECT COALESCE(SUM(pjs.actual_working_minutes), 0)::float AS v
        FROM production_job_stages pjs
        JOIN production_execution_jobs ej ON ej.id = pjs.production_job_id
        WHERE ej.status IN ('IN_PROGRESS','HOLD')
      `);
      const pm = Number(plannedMinutes[0]?.v) || 1;
      const wm = Number(workedMinutes[0]?.v) || 0;
      const productionEfficiencyPct = pm > EPS ? Math.min(100, (wm / pm) * 100) : 0;

      return {
        wip_order_value:           wipVal,
        delayed_execution_hints:   Number(delayed[0]?.c) || 0,
        pending_dispatch_value:    Number(pendingDispatch[0]?.v) || 0,
        procurement_exposure:      Number(procurementExp[0]?.v) || 0,
        fg_stock_value:            fgStockValue,
        active_execution_jobs:     Number(execActive[0]?.c) || 0,
        loss_making_orders:        Number(lossOrders[0]?.c) || 0,
        production_efficiency_pct: productionEfficiencyPct,
      };
    } catch (e: any) {
      this.logger.warn(`[ManufacturingAnalytics] getIntelSummary: ${e?.message}`);
      return {
        wip_order_value: 0,
        delayed_execution_hints: 0,
        pending_dispatch_value: 0,
        procurement_exposure: 0,
        fg_stock_value: 0,
        active_execution_jobs: 0,
        loss_making_orders: 0,
        production_efficiency_pct: 0,
      };
    }
  }

  async getOverview(fromIso?: string, toIso?: string): Promise<Record<string, unknown>> {
    const from = fromIso ? new Date(fromIso) : new Date(Date.now() - 30 * 86400_000);
    const to = toIso ? new Date(toIso) : new Date();

    const snapAgg: any[] = await this.dataSource.query(
      `
      SELECT
        COUNT(*)::int AS snapshot_count,
        COALESCE(SUM(raw_material_cost), 0)::float AS raw_material_cost,
        COALESCE(SUM(production_cost), 0)::float AS production_cost,
        COALESCE(SUM(wastage_cost), 0)::float AS wastage_cost,
        COALESCE(SUM(dispatch_cost), 0)::float AS dispatch_cost,
        COALESCE(SUM(total_cost), 0)::float AS total_cost,
        COALESCE(SUM(produced_qty), 0)::float AS total_produced_qty
      FROM production_cost_snapshots
      WHERE created_at >= $1 AND created_at <= $2
      `,
      [from, to],
    );

    const rejection: any[] = await this.dataSource.query(
      `
      SELECT
        CASE WHEN SUM(completed_qty + rejected_qty) > $3
          THEN SUM(rejected_qty) / SUM(completed_qty + rejected_qty) ELSE 0 END::float AS ratio
      FROM production_job_stages
      WHERE status = 'COMPLETED' AND completed_at >= $1 AND completed_at <= $2
      `,
      [from, to, EPS],
    );

    const throughput: any[] = await this.dataSource.query(
      `
      SELECT COALESCE(SUM(completed_qty), 0)::float AS units
      FROM production_execution_jobs
      WHERE status = 'COMPLETED' AND completed_at >= $1 AND completed_at <= $2
      `,
      [from, to],
    );

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      costSnapshots: snapAgg[0] ?? {},
      rejection_ratio_completed_stages: Number(rejection[0]?.ratio) || 0,
      fg_units_completed_jobs: Number(throughput[0]?.units) || 0,
    };
  }

  async getDepartmentPerformance(): Promise<any[]> {
    return this.dataSource.query(
      `
      SELECT
        d.id AS "departmentId",
        d.name AS "departmentName",
        COUNT(*) FILTER (WHERE pjs.status = 'COMPLETED')::int AS "stagesCompleted",
        COALESCE(AVG(pjs.actual_working_minutes) FILTER (WHERE pjs.status = 'COMPLETED'), 0)::float AS "avgWorkingMinutes",
        COUNT(*) FILTER (WHERE pjs.hold_reason IS NOT NULL)::int AS "holdCount",
        COALESCE(SUM(pjs.planned_qty) FILTER (WHERE pjs.status IN ('WORKING','READY','STOPPED','ON_HOLD')), 0)::float AS "wipPlannedQty",
        COALESCE(SUM(pjs.completed_qty) FILTER (WHERE pjs.status = 'COMPLETED'), 0)::float AS "outputQty"
      FROM departments d
      LEFT JOIN production_job_stages pjs ON pjs.department_id = d.id
      WHERE d.active = true
      GROUP BY d.id, d.name
      ORDER BY d.name
      `,
    );
  }

  async getDelayInsights(limit = 8): Promise<any[]> {
    return this.dataSource.query(
      `
      SELECT
        d.name AS "departmentName",
        COUNT(*)::int AS "delayedStages",
        COALESCE(AVG(EXTRACT(EPOCH FROM (now() - pjs.started_at)) / 3600.0), 0)::float AS "avgHoursOpen"
      FROM production_job_stages pjs
      JOIN departments d ON d.id = pjs.department_id
      JOIN production_execution_jobs ej ON ej.id = pjs.production_job_id
      WHERE pjs.started_at IS NOT NULL
        AND pjs.completed_at IS NULL
        AND pjs.status IN ('WORKING','READY','STOPPED','ON_HOLD')
        AND ej.status NOT IN ('COMPLETED','CANCELLED')
        AND pjs.started_at < now() - interval '24 hours'
      GROUP BY d.id, d.name
      ORDER BY "delayedStages" DESC, "avgHoursOpen" DESC
      LIMIT $1
      `,
      [limit],
    );
  }

  async getWastageLeaders(limit = 10): Promise<any[]> {
    return this.dataSource.query(
      `
      SELECT
        si.id AS "itemId",
        si.item_name AS "itemName",
        COALESCE(SUM(pcs.wastage_cost), 0)::float AS "wastageCost",
        COALESCE(SUM(pcs.produced_qty), 0)::float AS "producedQty"
      FROM production_cost_snapshots pcs
      JOIN service_items si ON si.id = pcs.item_id
      GROUP BY si.id, si.item_name
      ORDER BY "wastageCost" DESC
      LIMIT $1
      `,
      [limit],
    );
  }

  async getMaterialInsights(limit = 12): Promise<{
    topConsumed: any[];
    shortages: any[];
    expensive: any[];
    highWastageTx: any[];
  }> {
    const topConsumed = await this.dataSource.query(
      `
      SELECT t.item_id AS "itemId", si.item_name AS "itemName",
        SUM(t.qty)::float AS "qtyOut",
        COALESCE(SUM(t.qty * COALESCE(t.rate, si.cost_price, 0)), 0)::float AS "valueOut"
      FROM inventory_transactions t
      JOIN service_items si ON si.id = t.item_id
      WHERE t.transaction_type = 'PRODUCTION_CONSUMPTION' AND t.direction = 'OUT'
      GROUP BY t.item_id, si.item_name
      ORDER BY "qtyOut" DESC
      LIMIT $1
      `,
      [limit],
    );

    const shortages = await this.dataSource.query(
      `
      SELECT pr.item_id AS "itemId", si.item_name AS "itemName",
        COUNT(*)::int AS "shortageEvents",
        COALESCE(SUM(pr.shortage_qty), 0)::float AS "shortageQty"
      FROM purchase_requirements pr
      JOIN service_items si ON si.id = pr.item_id
      WHERE COALESCE(pr.shortage_qty, 0) > 0
      GROUP BY pr.item_id, si.item_name
      ORDER BY "shortageEvents" DESC
      LIMIT $1
      `,
      [limit],
    );

    const expensive = await this.dataSource.query(
      `
      SELECT t.item_id AS "itemId", si.item_name AS "itemName",
        COALESCE(AVG(NULLIF(t.rate, 0)), AVG(si.cost_price), 0)::float AS "avgRate"
      FROM inventory_transactions t
      JOIN service_items si ON si.id = t.item_id
      WHERE t.transaction_type = 'PRODUCTION_CONSUMPTION' AND t.direction = 'OUT'
      GROUP BY t.item_id, si.item_name
      HAVING COALESCE(AVG(NULLIF(t.rate, 0)), AVG(si.cost_price), 0) > 0
      ORDER BY "avgRate" DESC
      LIMIT $1
      `,
      [limit],
    );

    const highWastageTx = await this.dataSource.query(
      `
      SELECT t.item_id AS "itemId", si.item_name AS "itemName",
        SUM(t.qty)::float AS "qty",
        COALESCE(SUM(t.qty * COALESCE(t.rate, si.cost_price, 0)), 0)::float AS "value"
      FROM inventory_transactions t
      JOIN service_items si ON si.id = t.item_id
      WHERE t.transaction_type = 'PRODUCTION_CONSUMPTION' AND t.direction = 'OUT'
        AND (t.notes ILIKE '%wastage%' OR t.notes ILIKE '%reject%')
      GROUP BY t.item_id, si.item_name
      ORDER BY "value" DESC
      LIMIT $1
      `,
      [limit],
    );

    return { topConsumed, shortages, expensive, highWastageTx };
  }

  async getOrderProfitability(limit = 40): Promise<any[]> {
    return this.dataSource.query(
      `
      SELECT o.id AS "orderId",
        o.order_no AS "orderNo",
        o.customer_name AS "customerName",
        o.status AS "orderStatus",
        o.total_amount::float AS "salesValue",
        COALESCE(m.manu, 0)::float AS "manufacturingCost",
        COALESCE(d.disp, 0)::float AS "dispatchCost",
        (o.total_amount::float - COALESCE(m.manu, 0) - COALESCE(d.disp, 0))::float AS "grossProfit",
        CASE WHEN o.total_amount::float > $2
          THEN ((o.total_amount::float - COALESCE(m.manu, 0) - COALESCE(d.disp, 0)) / o.total_amount::float) * 100
          ELSE 0 END::float AS "grossMarginPct"
      FROM orders o
      LEFT JOIN (
        SELECT order_id,
          SUM(raw_material_cost + production_cost + wastage_cost) AS manu
        FROM production_cost_snapshots
        GROUP BY order_id
      ) m ON m.order_id = o.id
      LEFT JOIN (
        SELECT order_id,
          SUM(COALESCE(packing_cost,0)+COALESCE(logistics_cost,0)+COALESCE(misc_cost,0)) AS disp
        FROM dispatch_orders
        WHERE status NOT IN ('DRAFT','CANCELLED')
        GROUP BY order_id
      ) d ON d.order_id = o.id
      WHERE o.status NOT IN ('CANCELLED','REJECTED')
      ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
      LIMIT $1
      `,
      [limit, EPS],
    );
  }

  async listSnapshotsForOrder(orderId: number): Promise<ProductionCostSnapshot[]> {
    return this.snapRepo.find({
      where: { orderId },
      order: { createdAt: 'DESC' },
    });
  }

  async getSnapshotByJob(jobId: number): Promise<ProductionCostSnapshot> {
    const s = await this.snapRepo.findOne({ where: { productionJobId: jobId } });
    if (!s) throw new NotFoundException(`No cost snapshot for job ${jobId}`);
    return s;
  }
}

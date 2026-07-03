import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { ProductionExecutionJob } from './entities/production-execution-job.entity';
import { ProductionJobStage } from './entities/production-job-stage.entity';
import { InventoryTransaction } from '../inventory/entities/inventory-transaction.entity';
import { STAGE_USER_JOINS, STAGE_USER_SELECT } from '../shared/ownership.util';

const EPS = 1e-6;

type MaterialGate = 'OK' | 'PARTIAL' | 'SHORTAGE';

@Injectable()
export class ProductionExecutionService {
  private readonly logger = new Logger(ProductionExecutionService.name);

  constructor(
    @InjectRepository(ProductionExecutionJob)
    private readonly jobRepo: Repository<ProductionExecutionJob>,

    @InjectRepository(ProductionJobStage)
    private readonly stageRepo: Repository<ProductionJobStage>,

    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async userLabel(
    userId?: number | null,
  ): Promise<{ id: number | null; name: string | null }> {
    if (!userId) return { id: null, name: null };
    const [u] = await this.dataSource.query(
      `SELECT id, name FROM "user" WHERE id = $1`,
      [userId],
    );
    return { id: userId, name: u?.name ?? null };
  }

  // ── Event listener ────────────────────────────────────────────────────────────

  @OnEvent('order.approved')
  async onOrderApproved(payload: { orderId: number }): Promise<void> {
    try {
      await this.generateForOrder(payload.orderId);
    } catch (err: any) {
      this.logger.warn(
        `[ProdExec] Failed to generate execution jobs for order ${payload.orderId}: ${err?.message}`,
      );
    }
  }

  // ── Job generation ────────────────────────────────────────────────────────────

  /**
   * Idempotent: if execution jobs already exist for this order, returns early.
   * Only MANUFACTURING order items with an ACTIVE BOQ get jobs.
   * Stages are derived from BOQ lines in insertion order (sequence_no = row order).
   */
  async generateForOrder(orderId: number): Promise<void> {
    this.logger.log(
      `[ProdExec] Generating execution jobs for order ${orderId}…`,
    );

    const existing = await this.jobRepo.findOne({ where: { orderId } });
    if (existing) {
      this.logger.debug(
        `[ProdExec] Order ${orderId}: execution jobs already exist — skipping`,
      );
      return;
    }

    const eligibleItems: any[] = await this.dataSource.query(
      `SELECT
         oi.id          AS "orderItemId",
         oi.qty         AS "qty",
         si.id          AS "itemId",
         si.item_name   AS "itemName",
         b.id           AS "boqId"
       FROM order_item oi
       JOIN service_items si
         ON si.sku = oi.sku
        AND si.main_category_type = 'MANUFACTURING'
        AND si.is_active = true
       JOIN manufacturing_boqs b
         ON b.item_id = si.id
        AND b.status = 'ACTIVE'
       WHERE oi."orderId" = $1
       ORDER BY oi.id`,
      [orderId],
    );

    if (!eligibleItems.length) {
      this.logger.debug(
        `[ProdExec] Order ${orderId}: no MANUFACTURING items with active BOQ`,
      );
      return;
    }

    for (const item of eligibleItems) {
      const qty = Number(item.qty) || 1;

      const boqLines: any[] = await this.dataSource.query(
        `SELECT id, department_id, qty_per_unit, consumption_type
         FROM manufacturing_boq_items
         WHERE boq_id = $1
         ORDER BY id ASC`,
        [item.boqId],
      );

      const job = this.jobRepo.create({
        orderId,
        orderItemId: item.orderItemId,
        itemId: item.itemId,
        boqId: item.boqId,
        qty,
        status: boqLines.length > 0 ? 'READY' : 'PENDING',
        priority: 'MEDIUM',
      });
      const savedJob = await this.jobRepo.save(job);

      const seen = new Set<number>();
      const stages: ProductionJobStage[] = [];
      let seq = 1;

      for (const line of boqLines) {
        const deptId = Number(line.department_id);
        if (seen.has(deptId)) continue;
        seen.add(deptId);

        const stage = this.stageRepo.create({
          productionJobId: savedJob.id,
          departmentId: deptId,
          sequenceNo: seq,
          status: seq === 1 ? 'READY' : 'PENDING',
          plannedQty: qty,
        });
        stages.push(stage);
        seq++;
      }

      if (stages.length) {
        await this.stageRepo.save(stages);
      }

      this.logger.log(
        `[ProdExec] Order ${orderId}: job #${savedJob.id} created for item ${item.itemName} ` +
          `with ${stages.length} stage(s)`,
      );
    }
  }

  // ── Material helpers ─────────────────────────────────────────────────────────

  private async defaultWarehouseId(m?: EntityManager): Promise<number> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT id FROM warehouses WHERE active IS NOT FALSE ORDER BY id ASC LIMIT 1`,
    );
    if (!rows.length)
      throw new BadRequestException(
        'No warehouse configured — cannot run production inventory',
      );
    return Number(rows[0].id);
  }

  private async stockByWarehouse(
    itemId: number,
    m?: EntityManager,
  ): Promise<{ warehouseId: number; qty: number }[]> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT
         t.warehouse_id AS "warehouseId",
         COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty
                           WHEN t.direction = 'OUT' THEN -t.qty
                           ELSE 0 END), 0)::float AS qty
       FROM inventory_transactions t
       WHERE t.item_id = $1
       GROUP BY t.warehouse_id
       HAVING COALESCE(SUM(CASE WHEN t.direction = 'IN'  THEN t.qty
                                 WHEN t.direction = 'OUT' THEN -t.qty
                                 ELSE 0 END), 0) > $2
       ORDER BY qty DESC, t.warehouse_id ASC`,
      [itemId, EPS],
    );
    return rows.map((r) => ({
      warehouseId: Number(r.warehouseId),
      qty: Number(r.qty),
    }));
  }

  private async itemCostPrice(
    itemId: number,
    m?: EntityManager,
  ): Promise<number | null> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT cost_price::float AS cp FROM service_items WHERE id = $1`,
      [itemId],
    );
    if (!rows.length) return null;
    const v = Number(rows[0].cp);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  private async orderItemQty(
    orderItemId: number,
    m?: EntityManager,
  ): Promise<number> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT qty::float AS q FROM order_item WHERE id = $1`,
      [orderItemId],
    );
    if (!rows.length) return 1;
    const qn = Number(rows[0].q);
    return qn > 0 ? qn : 1;
  }

  /** Per raw: scaled OMR calculated qty for this execution job */
  private async jobMaterialRequirements(
    job: ProductionExecutionJob,
    orderLineQty: number,
    m?: EntityManager,
  ): Promise<Map<number, number>> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT raw_material_item_id AS "rawId", calculated_qty::float AS cq
       FROM order_material_requirements
       WHERE order_id = $1 AND order_item_id = $2`,
      [job.orderId, job.orderItemId],
    );
    const scale = Number(job.qty) / orderLineQty;
    const map = new Map<number, number>();
    for (const r of rows) {
      const rawId = Number(r.rawId);
      const add = Number(r.cq) * scale;
      map.set(rawId, (map.get(rawId) ?? 0) + add);
    }
    return map;
  }

  /** Department-specific need (full job qty basis) for material gate before START */
  private async deptMaterialNeedMap(
    boqId: number,
    departmentId: number,
    jobQty: number,
    m?: EntityManager,
  ): Promise<Map<number, number>> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const lines: any[] = await q(
      `SELECT raw_material_item_id AS "rawId", qty_per_unit::float AS qpu, wastage_percent::float AS wp
       FROM manufacturing_boq_items
       WHERE boq_id = $1 AND department_id = $2`,
      [boqId, departmentId],
    );
    const map = new Map<number, number>();
    for (const L of lines) {
      const rawId = Number(L.rawId);
      const qpu = Number(L.qpu) || 0;
      const wp = Number(L.wp) || 0;
      const need = qpu * (1 + wp / 100) * Number(jobQty);
      map.set(rawId, (map.get(rawId) ?? 0) + need);
    }
    return map;
  }

  private async materialGateForNeedMap(
    needMap: Map<number, number>,
  ): Promise<MaterialGate> {
    let anyNeed = false;
    let anyShort = false;
    let anyPartial = false;
    for (const [rawId, need] of needMap) {
      if (need <= EPS) continue;
      anyNeed = true;
      const wh = await this.stockByWarehouse(rawId);
      const avail = wh.reduce((s, w) => s + w.qty, 0);
      if (avail <= EPS) anyShort = true;
      else if (avail + EPS < need) anyPartial = true;
    }
    if (!anyNeed) return 'OK';
    if (anyShort) return 'SHORTAGE';
    if (anyPartial) return 'PARTIAL';
    return 'OK';
  }

  private async assertReservationGateAllowsStart(
    jobId: number,
    m?: EntityManager,
  ): Promise<void> {
    const q = m?.query.bind(m) ?? this.dataSource.query.bind(this.dataSource);
    const rows: any[] = await q(
      `SELECT raw_material_item_id AS "rawId",
              SUM(required_qty)::float AS rq,
              SUM(reserved_qty)::float AS rs
       FROM production_material_reservations
       WHERE production_job_id = $1 AND status <> 'CANCELLED'
       GROUP BY raw_material_item_id`,
      [jobId],
    );
    const shorts: string[] = [];
    for (const r of rows) {
      const rq = Number(r.rq);
      const rs = Number(r.rs);
      if (rq > EPS && rs <= EPS) {
        const nm: any[] = await q(
          `SELECT item_name FROM service_items WHERE id = $1`,
          [r.rawId],
        );
        shorts.push(nm[0]?.item_name ?? `Item #${r.rawId}`);
      }
    }
    if (shorts.length) {
      throw new BadRequestException(
        `Cannot start production: no stock reserved for required material(s): ${shorts.join(', ')}`,
      );
    }
  }

  private async createReservationsForJob(
    job: ProductionExecutionJob,
    orderLineQty: number,
    m: EntityManager,
  ): Promise<void> {
    const needMap = await this.jobMaterialRequirements(job, orderLineQty, m);
    const wh0 = await this.defaultWarehouseId(m);
    for (const [rawId, required] of needMap) {
      if (required <= EPS) continue;
      const plannedRate = await this.itemCostPrice(rawId, m);
      const balances = await this.stockByWarehouse(rawId, m);
      const totalAvail = balances.reduce((s, b) => s + b.qty, 0);
      const reserved = Math.min(required, totalAvail);
      const warehouseId =
        reserved > EPS
          ? (balances.sort((a, b) => b.qty - a.qty)[0]?.warehouseId ?? wh0)
          : wh0;
      let st = 'RESERVED';
      if (reserved <= EPS) st = 'PARTIAL';
      else if (reserved + EPS < required) st = 'PARTIAL';
      else st = 'RESERVED';
      await m.query(
        `INSERT INTO production_material_reservations
           (production_job_id, production_stage_id, raw_material_item_id, required_qty, reserved_qty,
            consumed_qty, warehouse_id, status, remarks, planned_rate, actual_rate, consumed_value)
         VALUES ($1, NULL, $2, $3, $4, 0, $5, $6, NULL, $7, NULL, NULL)`,
        [job.id, rawId, required, reserved, warehouseId, st, plannedRate],
      );
    }
  }

  private async consumeDepartmentMaterials(
    m: EntityManager,
    job: ProductionExecutionJob,
    stage: ProductionJobStage,
    throughput: number,
    userId?: number,
    wastageRemarks?: string,
  ): Promise<void> {
    const lines: any[] = await m.query(
      `SELECT raw_material_item_id AS "rawId", qty_per_unit::float AS qpu, wastage_percent::float AS wp
       FROM manufacturing_boq_items
       WHERE boq_id = $1 AND department_id = $2`,
      [job.boqId, stage.departmentId],
    );
    const needByRaw = new Map<number, { theory: number; withW: number }>();
    for (const L of lines) {
      const rawId = Number(L.rawId);
      const qpu = Number(L.qpu) || 0;
      const wp = Number(L.wp) || 0;
      const theory = qpu * throughput;
      const withW = qpu * (1 + wp / 100) * throughput;
      const cur = needByRaw.get(rawId) ?? { theory: 0, withW: 0 };
      cur.theory += theory;
      cur.withW += withW;
      needByRaw.set(rawId, cur);
    }

    for (const [rawId, { theory, withW }] of needByRaw) {
      let remaining = Math.max(0, withW);
      const resRows: any[] = await m.query(
        `SELECT id, reserved_qty::float AS rq, consumed_qty::float AS cq,
                consumed_value::float AS consumed_value, warehouse_id AS wh
         FROM production_material_reservations
         WHERE production_job_id = $1 AND raw_material_item_id = $2 AND status <> 'CANCELLED'
         ORDER BY id ASC`,
        [job.id, rawId],
      );
      const plannedRate = await this.itemCostPrice(rawId, m);
      for (const rr of resRows) {
        const wh = Number(rr.wh);
        const resReserved = Number(rr.rq);
        let cq = Number(rr.cq);
        let cv = Number(rr.consumed_value) || 0;
        while (remaining > EPS) {
          const canFromRes = Math.max(0, resReserved - cq);
          const balances = await this.stockByWarehouse(rawId, m);
          const phys = balances.find((b) => b.warehouseId === wh)?.qty ?? 0;
          const outQty = Math.min(remaining, canFromRes, phys);
          if (outQty <= EPS) break;

          const actualRate = plannedRate ?? null;
          const lineValue = actualRate != null ? outQty * actualRate : null;

          const tx = m.create(InventoryTransaction, {
            itemId: rawId,
            warehouseId: wh,
            transactionType: 'PRODUCTION_CONSUMPTION',
            direction: 'OUT',
            qty: outQty,
            unit: 'PCS',
            rate: actualRate,
            referenceType: 'PRODUCTION_JOB',
            referenceId: job.id,
            notes:
              `Stage ${stage.id}; planned BOQ ${theory.toFixed(4)}; with wastage ${withW.toFixed(4)}` +
              (wastageRemarks ? `; ${wastageRemarks}` : ''),
            createdBy: userId ?? null,
          });
          await m.save(tx);

          cq += outQty;
          cv += lineValue ?? 0;
          let st = 'PARTIAL';
          if (cq + EPS >= resReserved) st = 'CONSUMED';
          else if (cq <= EPS) st = 'RESERVED';
          await m.query(
            `UPDATE production_material_reservations
               SET consumed_qty = $1,
                   consumed_value = $2,
                   actual_rate = CASE WHEN $1 > 1e-9 THEN $2 / $1 ELSE NULL END,
                   production_stage_id = COALESCE(production_stage_id, $3),
                   status = $4
             WHERE id = $5`,
            [cq, cv, stage.id, st, rr.id],
          );
          remaining -= outQty;
        }
      }

      if (remaining > EPS) {
        const balances = await this.stockByWarehouse(rawId, m);
        const pick = balances.sort((a, b) => b.qty - a.qty)[0];
        if (!pick || pick.qty <= EPS) {
          this.logger.warn(
            `[ProdExec] Insufficient physical stock for raw ${rawId} job ${job.id} — need ${remaining} more`,
          );
          continue;
        }
        const outQty = Math.min(remaining, pick.qty);
        const actualRate = plannedRate ?? null;
        await m.save(
          m.create(InventoryTransaction, {
            itemId: rawId,
            warehouseId: pick.warehouseId,
            transactionType: 'PRODUCTION_CONSUMPTION',
            direction: 'OUT',
            qty: outQty,
            unit: 'PCS',
            rate: actualRate,
            referenceType: 'PRODUCTION_JOB',
            referenceId: job.id,
            notes: `Stage ${stage.id} (beyond reservation); planned ${theory.toFixed(4)}`,
            createdBy: userId ?? null,
          }),
        );
      }
    }
  }

  private async insertFgProductionIn(
    m: EntityManager,
    job: ProductionExecutionJob,
    stage: ProductionJobStage,
    userId?: number,
  ): Promise<void> {
    const qty = Number(stage.completedQty);
    if (qty <= EPS) return;
    const whRows: any[] = await m.query(
      `SELECT warehouse_id AS wid, SUM(reserved_qty)::float AS s
       FROM production_material_reservations
       WHERE production_job_id = $1 AND status <> 'CANCELLED'
       GROUP BY warehouse_id
       ORDER BY s DESC NULLS LAST, wid ASC
       LIMIT 1`,
      [job.id],
    );
    const warehouseId = whRows.length
      ? Number(whRows[0].wid)
      : await this.defaultWarehouseId(m);
    const rate = await this.itemCostPrice(job.itemId, m);
    await m.save(
      m.create(InventoryTransaction, {
        itemId: job.itemId,
        warehouseId,
        transactionType: 'FG_PRODUCTION_IN',
        direction: 'IN',
        qty,
        unit: 'PCS',
        rate,
        referenceType: 'PRODUCTION_JOB',
        referenceId: job.id,
        notes: `Final stage ${stage.id} FG receipt`,
        createdBy: userId ?? null,
      }),
    );
  }

  private async cancelUnusedReservations(
    jobId: number,
    m: EntityManager,
  ): Promise<void> {
    await m.query(
      `UPDATE production_material_reservations
       SET status = 'CANCELLED'
       WHERE production_job_id = $1
         AND consumed_qty < $2
         AND status NOT IN ('CONSUMED')`,
      [jobId, EPS],
    );
  }

  // ── Stage transitions ─────────────────────────────────────────────────────────

  /** READY → WORKING */
  private async deptNameForStage(stageId: number): Promise<string | null> {
    const [r] = await this.dataSource.query(
      `SELECT d.name FROM production_job_stages pjs
       JOIN departments d ON d.id = pjs.department_id WHERE pjs.id = $1`,
      [stageId],
    );
    return r?.name ?? null;
  }

  async startStage(
    stageId: number,
    userId?: number,
  ): Promise<ProductionJobStage> {
    const stage = await this.dataSource.transaction(async (m) => {
      const stage = await m.findOne(ProductionJobStage, {
        where: { id: stageId },
        relations: ['job'],
      });
      if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
      if (stage.status === 'WORKING') return stage;
      if (stage.status !== 'READY') {
        throw new BadRequestException(
          `Only READY stages can be started. Current status: ${stage.status}`,
        );
      }
      if (stage.job.status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot start a stage on a cancelled job',
        );
      }

      const orderLineQty = await this.orderItemQty(stage.job.orderItemId, m);

      if (stage.sequenceNo === 1) {
        const cnt: any[] = await m.query(
          `SELECT COUNT(*)::int AS c FROM production_material_reservations WHERE production_job_id = $1`,
          [stage.job.id],
        );
        if (!Number(cnt[0]?.c)) {
          await this.createReservationsForJob(stage.job, orderLineQty, m);
        }
        await this.assertReservationGateAllowsStart(stage.job.id, m);
      }

      stage.status = 'WORKING';
      stage.startedAt = stage.startedAt ?? new Date();
      if (userId) stage.assignedUserId = userId;
      await m.save(stage);

      const js = stage.job.status as string;
      if (js !== 'CANCELLED' && js !== 'COMPLETED') {
        await m.update(ProductionExecutionJob, stage.productionJobId, {
          status: 'IN_PROGRESS' as any,
          startedAt: stage.job.startedAt ?? new Date(),
        });
      }

      return stage;
    });
    const u = await this.userLabel(userId);
    const dept = await this.deptNameForStage(stageId);
    this.eventEmitter.emit('production.stage.started', {
      stage_id: stageId,
      job_id: stage.productionJobId,
      department_name: dept,
      user_id: u.id,
      user_name: u.name,
    });
    return stage;
  }

  /** WORKING → ON_HOLD. Records hold start time and reason. */
  async holdStage(
    stageId: number,
    reason?: string,
    remarks?: string,
  ): Promise<ProductionJobStage> {
    const stage = await this.stageRepo.findOne({ where: { id: stageId } });
    if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
    if (stage.status !== 'WORKING') {
      throw new BadRequestException(
        `Only WORKING stages can be put on hold. Current: ${stage.status}`,
      );
    }
    stage.status = 'ON_HOLD';
    stage.holdStartedAt = new Date();
    if (reason) stage.holdReason = reason;
    if (remarks) stage.remarks = remarks;
    return this.stageRepo.save(stage);
  }

  /** ON_HOLD → WORKING. Accumulates hold time. */
  async resumeStage(stageId: number): Promise<ProductionJobStage> {
    const stage = await this.stageRepo.findOne({ where: { id: stageId } });
    if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
    if (stage.status !== 'ON_HOLD') {
      throw new BadRequestException(
        `Only ON_HOLD stages can be resumed. Current: ${stage.status}`,
      );
    }

    if (stage.holdStartedAt) {
      const holdMins =
        (Date.now() - new Date(stage.holdStartedAt).getTime()) / 60_000;
      stage.totalHoldMinutes = (stage.totalHoldMinutes ?? 0) + holdMins;
      stage.holdStartedAt = null;
    }
    stage.status = 'WORKING';
    return this.stageRepo.save(stage);
  }

  /**
   * WORKING → STOPPED.
   * Records quantities, consumes raw materials (inventory_transactions OUT),
   * computes actual working time (elapsed − total hold time).
   */
  async stopStage(
    stageId: number,
    completedQty: number,
    rejectedQty = 0,
    remarks?: string,
    userId?: number,
    wastageRemarks?: string,
  ): Promise<ProductionJobStage> {
    const stage = await this.dataSource.transaction(async (m) => {
      const stage = await m.findOne(ProductionJobStage, {
        where: { id: stageId },
        relations: ['job'],
      });
      if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
      if (stage.status !== 'WORKING') {
        throw new BadRequestException(
          `Only WORKING stages can be stopped. Current: ${stage.status}`,
        );
      }
      if (completedQty <= 0)
        throw new BadRequestException('completedQty must be > 0');
      if (completedQty + rejectedQty > stage.plannedQty + EPS) {
        throw new BadRequestException(
          `completedQty + rejectedQty (${completedQty + rejectedQty}) exceeds plannedQty (${stage.plannedQty})`,
        );
      }

      const throughput = completedQty + rejectedQty;

      await this.consumeDepartmentMaterials(
        m,
        stage.job,
        stage,
        throughput,
        userId,
        wastageRemarks,
      );

      const now = new Date();
      stage.status = 'STOPPED';
      stage.completedQty = completedQty;
      stage.rejectedQty = rejectedQty;
      stage.stoppedAt = now;
      if (remarks) stage.remarks = remarks;
      if (wastageRemarks) stage.wastageRemarks = wastageRemarks;

      if (stage.startedAt) {
        const elapsed =
          (now.getTime() - new Date(stage.startedAt).getTime()) / 60_000;
        stage.actualWorkingMinutes = Math.max(
          0,
          elapsed - (stage.totalHoldMinutes ?? 0),
        );
      }

      return m.save(stage);
    });
    const u = await this.userLabel(userId);
    const dept = await this.deptNameForStage(stageId);
    this.eventEmitter.emit('production.stage.stopped', {
      stage_id: stageId,
      job_id: stage.productionJobId,
      department_name: dept,
      user_id: u.id,
      user_name: u.name,
    });
    return stage;
  }

  /**
   * STOPPED → COMPLETED.
   * Advances the next stage to READY, or marks the job COMPLETED if this was the last stage.
   * Final hand-off creates FG stock IN (inventory_transactions).
   */
  async moveNext(
    stageId: number,
    userId?: number,
  ): Promise<ProductionJobStage> {
    let completedJobId: number | null = null;
    const stage = await this.dataSource.transaction(async (m) => {
      const stage = await m.findOne(ProductionJobStage, {
        where: { id: stageId },
        relations: ['job'],
      });
      if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
      if (stage.status !== 'STOPPED') {
        throw new BadRequestException(
          `Only STOPPED stages can be moved to the next department. Current: ${stage.status}`,
        );
      }

      const now = new Date();
      stage.status = 'COMPLETED';
      stage.completedAt = now;
      stage.movedAt = now;
      if (userId) stage.movedBy = userId;
      await m.save(stage);

      const nextStage = await m.findOne(ProductionJobStage, {
        where: {
          productionJobId: stage.productionJobId,
          sequenceNo: stage.sequenceNo + 1,
        },
      });

      if (nextStage) {
        await m.update(ProductionJobStage, nextStage.id, { status: 'READY' });
        this.logger.log(
          `[ProdExec] Stage ${stageId} moved — dept ${nextStage.departmentId} is now READY`,
        );
      } else {
        await this.insertFgProductionIn(m, stage.job, stage, userId);
        await m.update(ProductionExecutionJob, stage.productionJobId, {
          status: 'COMPLETED' as any,
          completedAt: now,
          completedQty: stage.completedQty,
          rejectedQty: stage.rejectedQty,
        });
        this.logger.log(
          `[ProdExec] Job ${stage.productionJobId} fully COMPLETED`,
        );
        completedJobId = stage.productionJobId;
      }

      return stage;
    });
    if (completedJobId != null) {
      this.eventEmitter.emit('production.job.completed', {
        jobId: completedJobId,
      });
    }
    const u = await this.userLabel(userId);
    const dept = await this.deptNameForStage(stageId);
    this.eventEmitter.emit('production.stage.moved', {
      stage_id: stageId,
      job_id: stage.productionJobId,
      department_name: dept,
      user_id: u.id,
      user_name: u.name,
    });
    return stage;
  }

  /**
   * Legacy one-shot complete: WORKING → COMPLETED (skips the STOPPED intermediate state).
   */
  async completeStage(
    stageId: number,
    completedQty: number,
    rejectedQty = 0,
    remarks?: string,
    userId?: number,
    wastageRemarks?: string,
  ): Promise<ProductionJobStage> {
    let completedJobId: number | null = null;
    const stage = await this.dataSource.transaction(async (m) => {
      const stage = await m.findOne(ProductionJobStage, {
        where: { id: stageId },
        relations: ['job'],
      });
      if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
      if (stage.status !== 'WORKING') {
        throw new BadRequestException(
          `Only WORKING stages can be completed. Current status: ${stage.status}`,
        );
      }
      if (completedQty <= 0)
        throw new BadRequestException('completedQty must be > 0');
      if (completedQty + rejectedQty > stage.plannedQty + EPS) {
        throw new BadRequestException(
          `completedQty + rejectedQty (${completedQty + rejectedQty}) exceeds plannedQty (${stage.plannedQty})`,
        );
      }

      const orderLineQty = await this.orderItemQty(stage.job.orderItemId, m);
      if (stage.sequenceNo === 1) {
        const cnt: any[] = await m.query(
          `SELECT COUNT(*)::int AS c FROM production_material_reservations WHERE production_job_id = $1`,
          [stage.job.id],
        );
        if (!Number(cnt[0]?.c))
          await this.createReservationsForJob(stage.job, orderLineQty, m);
        await this.assertReservationGateAllowsStart(stage.job.id, m);
      }

      const throughput = completedQty + rejectedQty;
      await this.consumeDepartmentMaterials(
        m,
        stage.job,
        stage,
        throughput,
        userId,
        wastageRemarks,
      );

      const now = new Date();
      stage.status = 'COMPLETED';
      stage.completedQty = completedQty;
      stage.rejectedQty = rejectedQty;
      stage.completedAt = now;
      stage.stoppedAt = now;
      if (userId) stage.movedBy = userId;
      stage.movedAt = now;
      if (remarks) stage.remarks = remarks;
      if (wastageRemarks) stage.wastageRemarks = wastageRemarks;
      if (stage.startedAt) {
        const elapsed =
          (now.getTime() - new Date(stage.startedAt).getTime()) / 60_000;
        stage.actualWorkingMinutes = Math.max(
          0,
          elapsed - (stage.totalHoldMinutes ?? 0),
        );
      }
      await m.save(stage);

      const nextStage = await m.findOne(ProductionJobStage, {
        where: {
          productionJobId: stage.productionJobId,
          sequenceNo: stage.sequenceNo + 1,
        },
      });

      if (nextStage) {
        await m.update(ProductionJobStage, nextStage.id, { status: 'READY' });
      } else {
        await this.insertFgProductionIn(m, stage.job, stage, userId);
        await m.update(ProductionExecutionJob, stage.productionJobId, {
          status: 'COMPLETED' as any,
          completedAt: now,
          completedQty: completedQty,
          rejectedQty: rejectedQty,
        });
        this.logger.log(
          `[ProdExec] Job ${stage.productionJobId} fully COMPLETED`,
        );
        completedJobId = stage.productionJobId;
      }

      return stage;
    });
    if (completedJobId != null) {
      this.eventEmitter.emit('production.job.completed', {
        jobId: completedJobId,
      });
    }
    return stage;
  }

  async cancelStage(
    stageId: number,
    remarks?: string,
  ): Promise<ProductionJobStage> {
    return this.dataSource.transaction(async (m) => {
      const stage = await m.findOne(ProductionJobStage, {
        where: { id: stageId },
        relations: ['job'],
      });
      if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
      if (stage.status === 'COMPLETED') {
        throw new BadRequestException('Cannot cancel a completed stage');
      }
      if (stage.job.status === 'CANCELLED') return stage;

      stage.status = 'CANCELLED';
      if (remarks) stage.remarks = remarks;
      await m.save(stage);

      await this.cancelUnusedReservations(stage.productionJobId, m);

      const activeStages = await m.count(ProductionJobStage, {
        where: [
          { productionJobId: stage.productionJobId, status: 'PENDING' },
          { productionJobId: stage.productionJobId, status: 'READY' },
          { productionJobId: stage.productionJobId, status: 'WORKING' },
          { productionJobId: stage.productionJobId, status: 'ON_HOLD' },
          { productionJobId: stage.productionJobId, status: 'STOPPED' },
        ],
      });
      if (activeStages === 0) {
        await m.update(ProductionExecutionJob, stage.productionJobId, {
          status: 'CANCELLED' as any,
        });
      }
      return stage;
    });
  }

  async assignStage(
    stageId: number,
    userId: number,
  ): Promise<ProductionJobStage> {
    const stage = await this.stageRepo.findOne({ where: { id: stageId } });
    if (!stage) throw new NotFoundException(`Stage ${stageId} not found`);
    stage.assignedUserId = userId;
    return this.stageRepo.save(stage);
  }

  // ── Query APIs ────────────────────────────────────────────────────────────────

  async findJobs(
    filters: {
      status?: string;
      priority?: string;
      departmentId?: number;
      orderId?: number;
    } = {},
  ): Promise<any[]> {
    const conds: string[] = [];
    const params: any[] = [];

    if (filters.status) {
      params.push(filters.status);
      conds.push(`ej.status   = $${params.length}`);
    }
    if (filters.priority) {
      params.push(filters.priority);
      conds.push(`ej.priority = $${params.length}`);
    }
    if (filters.orderId) {
      params.push(filters.orderId);
      conds.push(`ej.order_id = $${params.length}`);
    }
    if (filters.departmentId) {
      params.push(filters.departmentId);
      conds.push(
        `EXISTS (SELECT 1 FROM production_job_stages pjs WHERE pjs.production_job_id = ej.id AND pjs.department_id = $${params.length})`,
      );
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    return this.dataSource.query(
      `SELECT
         ej.*,
         si.item_name      AS "itemName",
         si.item_code      AS "itemCode",
         o.order_no        AS "orderNo",
         o.customer_name   AS "customerName",
         o.status          AS "orderStatus",
         o.salesman_id     AS "salesmanId",
         sm.name           AS "salesmanName",
         sm.mobile         AS "salesmanPhone",
         sm.role           AS "salesmanRole",
         (SELECT COUNT(*) FROM production_job_stages pjs WHERE pjs.production_job_id = ej.id)               AS "totalStages",
         (SELECT COUNT(*) FROM production_job_stages pjs WHERE pjs.production_job_id = ej.id AND pjs.status = 'COMPLETED') AS "completedStages",
         (SELECT d.name FROM production_job_stages pjs JOIN departments d ON d.id = pjs.department_id
          WHERE pjs.production_job_id = ej.id AND pjs.status IN ('READY','WORKING','ON_HOLD','STOPPED')
          ORDER BY pjs.sequence_no LIMIT 1) AS "currentDeptName"
       FROM production_execution_jobs ej
       LEFT JOIN service_items si ON si.id = ej.item_id
       LEFT JOIN orders o         ON o.id  = ej.order_id
       LEFT JOIN "user" sm        ON sm.id = o.salesman_id
       ${where}
       ORDER BY
         CASE ej.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         ej.created_at DESC`,
      params,
    );
  }

  private async buildMaterialSummary(jobId: number, jobRow: any): Promise<any> {
    const reservations: any[] = await this.dataSource.query(
      `SELECT r.*,
              si.item_name AS "rawItemName",
              si.item_code AS "rawItemCode",
              w.name       AS "warehouseName"
       FROM production_material_reservations r
       JOIN service_items si ON si.id = r.raw_material_item_id
       JOIN warehouses w     ON w.id = r.warehouse_id
       WHERE r.production_job_id = $1
       ORDER BY r.id`,
      [jobId],
    );

    const byRaw = new Map<number, any>();
    for (const r of reservations) {
      const rid = Number(r.raw_material_item_id);
      if (!byRaw.has(rid)) {
        byRaw.set(rid, {
          rawMaterialItemId: rid,
          rawItemName: r.rawItemName,
          rawItemCode: r.rawItemCode,
          requiredQty: 0,
          reservedQty: 0,
          consumedQty: 0,
          remainingQty: 0,
          status: r.status,
          warehouseName: r.warehouseName,
        });
      }
      const agg = byRaw.get(rid)!;
      agg.requiredQty = Math.max(agg.requiredQty, Number(r.required_qty));
      agg.reservedQty += Number(r.reserved_qty);
      agg.consumedQty += Number(r.consumed_qty);
    }
    for (const agg of byRaw.values()) {
      agg.remainingQty = Math.max(
        0,
        Number(agg.requiredQty) - Number(agg.consumedQty),
      );
    }

    let gate: MaterialGate = 'OK';
    if (byRaw.size) {
      for (const agg of byRaw.values()) {
        if (agg.requiredQty > EPS && agg.reservedQty <= EPS) gate = 'SHORTAGE';
        else if (agg.reservedQty + EPS < agg.requiredQty && gate !== 'SHORTAGE')
          gate = 'PARTIAL';
      }
    } else {
      const pseudoJob = {
        id: jobId,
        orderId: jobRow.order_id,
        orderItemId: jobRow.order_item_id,
        itemId: jobRow.item_id,
        boqId: jobRow.boq_id,
        qty: Number(jobRow.qty),
      } as ProductionExecutionJob;
      gate = await this.materialGateForNeedMap(
        await this.jobMaterialRequirements(
          pseudoJob,
          await this.orderItemQty(jobRow.order_item_id),
        ),
      );
    }

    const fgProduced = Number(jobRow.completed_qty ?? jobRow.completedQty ?? 0);

    return {
      gate,
      reservations,
      byRaw: [...byRaw.values()],
      fgProducedQty: fgProduced,
    };
  }

  async findJobById(id: number): Promise<any> {
    const rows = await this.dataSource.query(
      `SELECT
         ej.*,
         si.item_name    AS "itemName",
         si.item_code    AS "itemCode",
         si.sku          AS "itemSku",
         o.order_no      AS "orderNo",
         o.customer_name AS "customerName",
         o.status        AS "orderStatus",
         o.salesman_id   AS "salesmanId",
         sm.name         AS "salesmanName",
         sm.mobile       AS "salesmanPhone",
         sm.role         AS "salesmanRole"
       FROM production_execution_jobs ej
       LEFT JOIN service_items si ON si.id = ej.item_id
       LEFT JOIN orders o         ON o.id  = ej.order_id
       LEFT JOIN "user" sm        ON sm.id = o.salesman_id
       WHERE ej.id = $1`,
      [id],
    );
    if (!rows.length)
      throw new NotFoundException(`Execution job ${id} not found`);

    const job = rows[0];

    const stages = await this.dataSource.query(
      `SELECT
         pjs.*,
         d.name AS "departmentName",
         d.code AS "departmentCode",
         ${STAGE_USER_SELECT}
       FROM production_job_stages pjs
       LEFT JOIN departments d ON d.id = pjs.department_id
       ${STAGE_USER_JOINS}
       WHERE pjs.production_job_id = $1
       ORDER BY pjs.sequence_no`,
      [id],
    );

    const materialSummary = await this.buildMaterialSummary(id, job);

    return { ...job, stages, materialSummary };
  }

  private async applyMaterialGateToQueueRows(rows: any[]): Promise<void> {
    for (const row of rows) {
      if (row.status === 'READY') {
        const orderLineQty = await this.orderItemQty(
          Number(row.orderItemId ?? row.order_item_id),
        );
        const need = await this.deptMaterialNeedMap(
          Number(row.boqId ?? row.boq_id),
          Number(row.department_id),
          Number(row.jobQty ?? row.job_qty),
        );
        row.material_gate = await this.materialGateForNeedMap(need);
      } else {
        row.material_gate = 'OK';
      }
    }
  }

  async findMyStages(userId: number): Promise<any[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT
         pjs.*,
         d.name            AS "departmentName",
         d.code            AS "departmentCode",
         ${STAGE_USER_SELECT},
         ej.qty            AS "jobQty",
         ej.boq_id         AS "boqId",
         ej.order_item_id  AS "orderItemId",
         ej.priority       AS "jobPriority",
         ej.order_id       AS "orderId",
         ej.id             AS "jobId",
         o.order_no        AS "orderNo",
         o.customer_name   AS "customerName",
         si.item_name      AS "itemName"
       FROM production_job_stages pjs
       JOIN production_execution_jobs ej ON ej.id  = pjs.production_job_id
       LEFT JOIN departments d            ON d.id   = pjs.department_id
       ${STAGE_USER_JOINS}
       LEFT JOIN orders o                 ON o.id   = ej.order_id
       LEFT JOIN service_items si         ON si.id  = ej.item_id
       WHERE pjs.assigned_user_id = $1
         AND pjs.status NOT IN ('COMPLETED', 'CANCELLED')
       ORDER BY
         CASE ej.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         pjs.sequence_no`,
      [userId],
    );
    await this.applyMaterialGateToQueueRows(rows);
    return rows;
  }

  async findDepartmentQueue(departmentId: number): Promise<any[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT
         pjs.*,
         ej.id           AS "jobId",
         ej.qty          AS "jobQty",
         ej.boq_id       AS "boqId",
         ej.order_item_id AS "orderItemId",
         ej.priority     AS "jobPriority",
         ej.order_id     AS "orderId",
         o.order_no      AS "orderNo",
         o.customer_name AS "customerName",
         si.item_name    AS "itemName"
       FROM production_job_stages pjs
       JOIN production_execution_jobs ej ON ej.id = pjs.production_job_id
       LEFT JOIN orders o                ON o.id  = ej.order_id
       LEFT JOIN service_items si        ON si.id = ej.item_id
       WHERE pjs.department_id = $1
         AND pjs.status IN ('READY', 'WORKING', 'ON_HOLD', 'STOPPED')
       ORDER BY
         CASE ej.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         ej.created_at`,
      [departmentId],
    );

    await this.applyMaterialGateToQueueRows(rows);

    return rows;
  }

  async updateJobPriority(jobId: number, priority: string): Promise<any> {
    const valid = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    if (!valid.includes(priority))
      throw new BadRequestException(`Invalid priority: ${priority}`);
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    await this.jobRepo.update(jobId, { priority: priority as any });
    return this.findJobById(jobId);
  }

  async regenerateForOrder(orderId: number): Promise<{ message: string }> {
    await this.dataSource.query(
      `DELETE FROM production_execution_jobs WHERE order_id = $1`,
      [orderId],
    );
    await this.generateForOrder(orderId);
    return { message: `Execution jobs regenerated for order ${orderId}` };
  }
}

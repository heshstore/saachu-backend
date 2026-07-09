'use strict';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { ProductionBoardTask } from './entities/production-board-task.entity';
import { DepartmentControlService } from '../departments/department-control.service';

@Injectable()
export class ProductionBoardService {
  private readonly logger = new Logger(ProductionBoardService.name);

  constructor(
    @InjectRepository(ProductionBoardTask)
    private readonly taskRepo: Repository<ProductionBoardTask>,
    private readonly dataSource: DataSource,
    private readonly deptCtrl: DepartmentControlService,
  ) {}

  // ── Order approval hook ────────────────────────────────────────────────────

  @OnEvent('order.approved')
  async onOrderApproved(payload: { orderId: number }): Promise<void> {
    try {
      await this.generateForOrder(payload.orderId);
    } catch (err: any) {
      this.logger.warn(
        `[ProdBoard] Failed to generate board entries for order ${payload.orderId}: ${err?.message}`,
      );
    }
  }

  /**
   * Idempotent. Creates one WAITING board task per order item.
   * Captures item_type so trading items are handled correctly.
   */
  async generateForOrder(orderId: number): Promise<void> {
    const existing = await this.taskRepo.findOne({ where: { orderId } });
    if (existing) return;

    const items: any[] = await this.dataSource.query(
      `SELECT
         oi.id            AS "orderItemId",
         oi.sku,
         oi.item_name     AS "itemName",
         oi.qty,
         oi.unit,
         o.order_no       AS "orderNo",
         o.customer_name  AS "customerName",
         o.due_date       AS "dueDate",
         COALESCE(si.main_category_type, 'OTHER') AS "itemType"
       FROM order_item oi
       JOIN orders o ON o.id = oi."orderId"
       LEFT JOIN service_items si ON si.sku = oi.sku AND si.is_active = true
       WHERE oi."orderId" = $1
       ORDER BY oi.id`,
      [orderId],
    );

    for (const item of items) {
      const task = this.taskRepo.create({
        orderId,
        orderItemId: Number(item.orderItemId),
        itemName: item.itemName,
        sku: item.sku,
        qty: Number(item.qty) || 1,
        unit: item.unit ?? null,
        itemType: item.itemType ?? 'OTHER',
        customerName: item.customerName,
        orderNo: item.orderNo,
        dueDate: item.dueDate ?? null,
        status: 'WAITING',
        stage: 'DEPARTMENT',
        taskNo: 1,
        priority: 'MEDIUM',
      });
      await this.taskRepo.save(task);
    }

    this.logger.log(
      `[ProdBoard] Created ${items.length} board task(s) for order ${orderId}`,
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async getDashboard(): Promise<any> {
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'WAITING')                                   AS "waitingAssignment",
         COUNT(*) FILTER (WHERE status IN ('ASSIGNED','IN_PROGRESS'))                 AS "inProgress",
         COUNT(*) FILTER (WHERE status = 'COMPLETED' AND stage = 'DEPARTMENT')        AS "waitingNextAssignment",
         COUNT(*) FILTER (WHERE stage = 'PACKING')                                    AS "packing",
         COUNT(*) FILTER (WHERE stage = 'BILLING')                                    AS "readyForBilling",
         COUNT(*) FILTER (WHERE stage = 'DONE')                                       AS "completedToday",
         COUNT(*) FILTER (WHERE status = 'ON_HOLD')                                   AS "onHold",
         COUNT(*) FILTER (
           WHERE status IN ('ASSIGNED','IN_PROGRESS')
             AND due_date < CURRENT_DATE
         )                                                                             AS "delayed"
       FROM production_board_tasks
       WHERE status <> 'CANCELLED'`,
    );

    const deptLoad: any[] = await this.dataSource.query(
      `SELECT
         t.department_id   AS "departmentId",
         t.department_name AS "departmentName",
         COUNT(*)          AS "activeCount"
       FROM production_board_tasks t
       WHERE t.status IN ('ASSIGNED','IN_PROGRESS')
         AND t.department_id IS NOT NULL
       GROUP BY t.department_id, t.department_name
       ORDER BY "activeCount" DESC`,
    );

    return { ...row, departmentWorkload: deptLoad };
  }

  // ── Board view ─────────────────────────────────────────────────────────────

  async getBoardView(filters: {
    orderId?: number;
    priority?: string;
    stage?: string;
  } = {}): Promise<any[]> {
    const conds: string[] = ["t.status <> 'CANCELLED'"];
    const params: any[] = [];

    if (filters.orderId) {
      params.push(filters.orderId);
      conds.push(`t.order_id = $${params.length}`);
    }
    if (filters.priority) {
      params.push(filters.priority);
      conds.push(`t.priority = $${params.length}`);
    }
    if (filters.stage) {
      params.push(filters.stage);
      conds.push(`t.stage = $${params.length}`);
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    const tasks: any[] = await this.dataSource.query(
      `SELECT
         t.*,
         -- Progress: completed / total non-cancelled tasks for this order item
         (SELECT COUNT(*) FROM production_board_tasks x
          WHERE x.order_item_id = t.order_item_id AND x.status = 'COMPLETED')::int  AS "completedTaskCount",
         (SELECT COUNT(*) FROM production_board_tasks x
          WHERE x.order_item_id = t.order_item_id AND x.status <> 'CANCELLED')::int AS "totalTaskCount",
         ab.name  AS "assignedByName",
         sb.name  AS "startedByName"
       FROM production_board_tasks t
       LEFT JOIN "user" ab ON ab.id = t.assigned_by
       LEFT JOIN "user" sb ON sb.id = t.started_by
       ${where}
       ORDER BY
         CASE t.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         t.task_no DESC,
         t.created_at DESC`,
      params,
    );

    return tasks.map((t) => ({
      ...t,
      progressPct: t.totalTaskCount > 0
        ? Math.round((t.completedTaskCount / t.totalTaskCount) * 100)
        : 0,
    }));
  }

  // ── Manager actions ────────────────────────────────────────────────────────

  /**
   * Assign a department to an order item.
   * If the item has a WAITING task, update it.
   * If returning from COMPLETED, create a new task (task_no increments).
   */
  async assignDepartment(
    orderItemId: number,
    departmentId: number,
    assignedBy: number,
    opts: { dependsOn?: number[]; remarks?: string } = {},
  ): Promise<ProductionBoardTask> {
    const dept: any[] = await this.dataSource.query(
      `SELECT id, name FROM departments WHERE id = $1`,
      [departmentId],
    );
    if (!dept.length) throw new NotFoundException(`Department ${departmentId} not found`);

    // Production lock: block assignment if department checklist is not complete today
    const readiness = await this.deptCtrl.getReadiness(departmentId);
    if (!readiness.ready) {
      throw new ForbiddenException(
        `Department "${dept[0].name}" is NOT READY — ${readiness.reason}. Complete the daily checklist before assigning jobs.`,
      );
    }

    // Find the latest non-cancelled task for this order item
    const latest = await this.taskRepo.findOne({
      where: { orderItemId },
      order: { taskNo: 'DESC', id: 'DESC' },
    });

    if (!latest) throw new NotFoundException(`No board entry for order item ${orderItemId}`);

    if (latest.status === 'WAITING') {
      // Update in place
      latest.departmentId = departmentId;
      latest.departmentName = dept[0].name;
      latest.assignedBy = assignedBy;
      latest.assignedAt = new Date();
      latest.status = 'ASSIGNED';
      if (opts.dependsOn?.length) latest.dependsOn = opts.dependsOn;
      if (opts.remarks) latest.remarks = opts.remarks;
      return this.taskRepo.save(latest);
    }

    if (latest.status === 'COMPLETED' && latest.stage === 'DEPARTMENT') {
      // Create next round
      const nextNo = (latest.taskNo ?? 1) + 1;
      const newTask = this.taskRepo.create({
        orderId: latest.orderId,
        orderItemId: latest.orderItemId,
        itemName: latest.itemName,
        sku: latest.sku,
        qty: latest.qty,
        unit: latest.unit,
        itemType: latest.itemType,
        customerName: latest.customerName,
        orderNo: latest.orderNo,
        dueDate: latest.dueDate,
        departmentId,
        departmentName: dept[0].name,
        status: opts.dependsOn?.length ? 'BLOCKED' : 'ASSIGNED',
        stage: 'DEPARTMENT',
        taskNo: nextNo,
        dependsOn: opts.dependsOn ?? [],
        priority: latest.priority,
        assignedBy,
        assignedAt: new Date(),
        remarks: opts.remarks ?? null,
      });
      return this.taskRepo.save(newTask);
    }

    throw new BadRequestException(
      `Cannot assign: item is currently in status ${latest.status}. ` +
      `Wait for the department to complete their work first.`,
    );
  }

  /**
   * Manager sends item to packing. Creates/updates a task with stage=PACKING.
   */
  async moveToPacking(
    orderItemId: number,
    assignedBy: number,
    remarks?: string,
  ): Promise<ProductionBoardTask> {
    const latest = await this.taskRepo.findOne({
      where: { orderItemId },
      order: { taskNo: 'DESC', id: 'DESC' },
    });
    if (!latest) throw new NotFoundException(`No board entry for order item ${orderItemId}`);

    const allowedStatuses: string[] = ['WAITING', 'COMPLETED'];
    if (!allowedStatuses.includes(latest.status)) {
      throw new BadRequestException(
        `Cannot send to packing: item status is ${latest.status}`,
      );
    }

    if (latest.status === 'WAITING' && latest.stage === 'DEPARTMENT') {
      latest.stage = 'PACKING';
      latest.status = 'ASSIGNED';
      latest.departmentName = 'Packing';
      latest.departmentId = null;
      latest.assignedBy = assignedBy;
      latest.assignedAt = new Date();
      if (remarks) latest.remarks = remarks;
      return this.taskRepo.save(latest);
    }

    const nextNo = (latest.taskNo ?? 1) + 1;
    const newTask = this.taskRepo.create({
      orderId: latest.orderId,
      orderItemId: latest.orderItemId,
      itemName: latest.itemName,
      sku: latest.sku,
      qty: latest.qty,
      unit: latest.unit,
      itemType: latest.itemType,
      customerName: latest.customerName,
      orderNo: latest.orderNo,
      dueDate: latest.dueDate,
      departmentId: null,
      departmentName: 'Packing',
      status: 'ASSIGNED',
      stage: 'PACKING',
      taskNo: nextNo,
      dependsOn: [],
      priority: latest.priority,
      assignedBy,
      assignedAt: new Date(),
      remarks: remarks ?? null,
    });
    return this.taskRepo.save(newTask);
  }

  /** Manager sends item to billing (from packing completed). */
  async moveToReadyForBilling(
    orderItemId: number,
    assignedBy: number,
    remarks?: string,
  ): Promise<ProductionBoardTask> {
    const latest = await this.taskRepo.findOne({
      where: { orderItemId },
      order: { taskNo: 'DESC', id: 'DESC' },
    });
    if (!latest) throw new NotFoundException(`No board entry for order item ${orderItemId}`);
    if (latest.stage !== 'PACKING' || latest.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Item must be in PACKING/COMPLETED state before billing. Current: ${latest.stage}/${latest.status}`,
      );
    }

    const nextNo = (latest.taskNo ?? 1) + 1;
    const newTask = this.taskRepo.create({
      orderId: latest.orderId,
      orderItemId: latest.orderItemId,
      itemName: latest.itemName,
      sku: latest.sku,
      qty: latest.qty,
      unit: latest.unit,
      itemType: latest.itemType,
      customerName: latest.customerName,
      orderNo: latest.orderNo,
      dueDate: latest.dueDate,
      departmentId: null,
      departmentName: 'Billing',
      status: 'ASSIGNED',
      stage: 'BILLING',
      taskNo: nextNo,
      dependsOn: [],
      priority: latest.priority,
      assignedBy,
      assignedAt: new Date(),
      remarks: remarks ?? null,
    });
    return this.taskRepo.save(newTask);
  }

  /** Manager puts an item on hold (affects current active task). */
  async holdItem(taskId: number, remarks?: string): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (!['WAITING', 'ASSIGNED', 'IN_PROGRESS'].includes(task.status)) {
      throw new BadRequestException(`Cannot hold task in status ${task.status}`);
    }
    task.status = 'ON_HOLD';
    task.heldAt = new Date();
    if (remarks) task.remarks = remarks;
    return this.taskRepo.save(task);
  }

  /** Manager cancels a task. */
  async cancelTask(taskId: number, remarks?: string): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (task.status === 'COMPLETED') {
      throw new BadRequestException('Cannot cancel a completed task');
    }
    task.status = 'CANCELLED';
    if (remarks) task.remarks = remarks;
    return this.taskRepo.save(task);
  }

  /** Manager changes priority of an item (propagates to all active tasks). */
  async changePriority(
    orderItemId: number,
    priority: string,
  ): Promise<void> {
    const valid = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    if (!valid.includes(priority)) throw new BadRequestException(`Invalid priority: ${priority}`);
    await this.taskRepo.update({ orderItemId }, { priority: priority as any });
  }

  // ── Department workspace ───────────────────────────────────────────────────

  async getDeptQueue(departmentId: number): Promise<any[]> {
    return this.dataSource.query(
      `SELECT
         t.*,
         ab.name AS "assignedByName"
       FROM production_board_tasks t
       LEFT JOIN "user" ab ON ab.id = t.assigned_by
       WHERE t.department_id = $1
         AND t.status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD')
       ORDER BY
         CASE t.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
         t.assigned_at ASC`,
      [departmentId],
    );
  }

  async getDeptDashboard(departmentId: number): Promise<any> {
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ASSIGNED','IN_PROGRESS'))  AS "todayQueue",
         COUNT(*) FILTER (WHERE status IN ('ASSIGNED','IN_PROGRESS') AND due_date < CURRENT_DATE) AS "delayed",
         COUNT(*) FILTER (WHERE status IN ('ASSIGNED','IN_PROGRESS') AND priority IN ('HIGH','URGENT')) AS "highPriority",
         COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= CURRENT_DATE) AS "completedToday",
         AVG(
           CASE WHEN status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM (completed_at - started_at)) / 60
           ELSE NULL END
         )::float AS "avgCompletionMinutes"
       FROM production_board_tasks
       WHERE department_id = $1`,
      [departmentId],
    );
    return row;
  }

  /** ASSIGNED → IN_PROGRESS */
  async startWork(taskId: number, userId: number): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (task.status !== 'ASSIGNED') {
      throw new BadRequestException(
        `Only ASSIGNED tasks can be started. Current: ${task.status}`,
      );
    }
    task.status = 'IN_PROGRESS';
    task.startedAt = new Date();
    task.startedBy = userId;
    return this.taskRepo.save(task);
  }

  /** IN_PROGRESS → COMPLETED. Item automatically returns to board (WAITING_NEXT_ASSIGNMENT shown via COMPLETED status). */
  async completeWork(
    taskId: number,
    userId: number,
    remarks?: string,
  ): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (!['IN_PROGRESS', 'ON_HOLD'].includes(task.status)) {
      throw new BadRequestException(
        `Only IN_PROGRESS tasks can be completed. Current: ${task.status}`,
      );
    }

    task.status = 'COMPLETED';
    task.completedAt = new Date();
    task.completedBy = userId;
    if (remarks) task.remarks = remarks;
    const saved = await this.taskRepo.save(task);

    // Unblock any tasks that were waiting on this one
    await this.resolveBlockedTasks(taskId, task.orderItemId);

    return saved;
  }

  /** IN_PROGRESS → ON_HOLD (department holds, reports problem) */
  async holdWork(taskId: number, userId: number, remarks?: string): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (task.status !== 'IN_PROGRESS') {
      throw new BadRequestException(`Only IN_PROGRESS tasks can be held. Current: ${task.status}`);
    }
    task.status = 'ON_HOLD';
    task.heldAt = new Date();
    if (remarks) task.remarks = remarks;
    return this.taskRepo.save(task);
  }

  /** Dept resumes held work */
  async resumeWork(taskId: number, userId: number): Promise<ProductionBoardTask> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    if (task.status !== 'ON_HOLD') {
      throw new BadRequestException(`Only ON_HOLD tasks can be resumed. Current: ${task.status}`);
    }
    task.status = 'IN_PROGRESS';
    task.heldAt = null;
    return this.taskRepo.save(task);
  }

  // ── Parallel task dependency resolution ───────────────────────────────────

  private async resolveBlockedTasks(
    completedTaskId: number,
    orderItemId: number,
  ): Promise<void> {
    // Find BLOCKED tasks for this order item that depend on completedTaskId
    const blocked = await this.taskRepo
      .createQueryBuilder('t')
      .where('t.orderItemId = :orderItemId', { orderItemId })
      .andWhere('t.status = :status', { status: 'BLOCKED' })
      .getMany();

    for (const t of blocked) {
      if (!t.dependsOn.includes(completedTaskId)) continue;

      // Check if ALL dependencies are now completed
      const depRows: any[] = await this.dataSource.query(
        `SELECT status FROM production_board_tasks WHERE id = ANY($1::int[])`,
        [t.dependsOn],
      );
      const allDone = depRows.every((r) => r.status === 'COMPLETED');
      if (allDone) {
        t.status = 'ASSIGNED';
        await this.taskRepo.save(t);
        this.logger.log(`[ProdBoard] Unblocked task ${t.id} — all dependencies complete`);
      }
    }
  }

  // ── Single task detail ─────────────────────────────────────────────────────

  async getTask(taskId: number): Promise<any> {
    const rows: any[] = await this.dataSource.query(
      `SELECT
         t.*,
         ab.name AS "assignedByName",
         sb.name AS "startedByName",
         cb.name AS "completedByName",
         (SELECT COUNT(*) FROM production_board_tasks x
          WHERE x.order_item_id = t.order_item_id AND x.status = 'COMPLETED')::int  AS "completedTaskCount",
         (SELECT COUNT(*) FROM production_board_tasks x
          WHERE x.order_item_id = t.order_item_id AND x.status <> 'CANCELLED')::int AS "totalTaskCount"
       FROM production_board_tasks t
       LEFT JOIN "user" ab ON ab.id = t.assigned_by
       LEFT JOIN "user" sb ON sb.id = t.started_by
       LEFT JOIN "user" cb ON cb.id = t.completed_by
       WHERE t.id = $1`,
      [taskId],
    );
    if (!rows.length) throw new NotFoundException(`Task ${taskId} not found`);
    const t = rows[0];
    return {
      ...t,
      progressPct: t.totalTaskCount > 0
        ? Math.round((t.completedTaskCount / t.totalTaskCount) * 100)
        : 0,
    };
  }

  /** Full history of an order item on the board */
  async getItemHistory(orderItemId: number): Promise<any[]> {
    return this.dataSource.query(
      `SELECT
         t.*,
         ab.name AS "assignedByName",
         sb.name AS "startedByName",
         cb.name AS "completedByName"
       FROM production_board_tasks t
       LEFT JOIN "user" ab ON ab.id = t.assigned_by
       LEFT JOIN "user" sb ON sb.id = t.started_by
       LEFT JOIN "user" cb ON cb.id = t.completed_by
       WHERE t.order_item_id = $1
       ORDER BY t.task_no, t.id`,
      [orderItemId],
    );
  }
}

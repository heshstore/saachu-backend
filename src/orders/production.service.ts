import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, EntityManager } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProductionJob, ProductionJobStatus, ProductionStage, JobPriority, ACTIVE_STATUSES } from './entities/production-job.entity';
import { ProductionAlert } from './entities/production-alert.entity';
import { ProductionEfficiency } from './entities/production-efficiency.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { User } from '../users/entities/user.entity';
import { AuditService } from '../logs/audit.service';
import { CrmWhatsappService } from './crm-whatsapp.service';

const STAGE_CAPACITY: Record<string, number> = {
  DESIGNING: 1000,
  PRINTING:  2000,
  LASER:     2500,
  ASSEMBLY:  1500,
};

const STAGE_FLOW: ProductionStage[] = [
  ProductionStage.DESIGNING,
  ProductionStage.PRINTING,
  ProductionStage.LASER,
  ProductionStage.ASSEMBLY,
  ProductionStage.COMPLETED,
];

const STAGE_ROLE_MAP: Record<string, string> = {
  DESIGNING: 'DESIGNER',
  PRINTING:  'PRINTER',
  LASER:     'LASER_OPERATOR',
  ASSEMBLY:  'ASSEMBLY_WORKER',
};


const ENABLE_DECISION_ENGINE = true;

const ESCALATION_ADMIN_ID = 1;
const ESCALATION_HOURS    = 24;

@Injectable()
export class ProductionService {
  constructor(
    @InjectRepository(ProductionJob)
    private repo: Repository<ProductionJob>,
    @InjectRepository(ProductionAlert)
    private alertRepo: Repository<ProductionAlert>,
    @InjectRepository(ProductionEfficiency)
    private effRepo: Repository<ProductionEfficiency>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private readonly audit: AuditService,
    private readonly crmWa: CrmWhatsappService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Creates production jobs for every line item on the order and returns them.
   *
   * When `em` is provided, all writes run inside the caller's transaction —
   * auto-assign is skipped so the caller can run it after the transaction
   * commits (rows must be visible before other connections can update them).
   *
   * When `em` is omitted, uses its own connection, creates jobs, and
   * auto-assigns them immediately (standalone / legacy path).
   *
   * Always idempotent: returns [] without writing if jobs already exist.
   */
  async createFromOrder(order: Order, em?: EntityManager): Promise<ProductionJob[]> {
    const mgr = em ?? this.repo.manager;

    // Idempotency check uses the same manager so it reads within the caller's
    // transaction and sees any jobs written earlier in the same tx.
    const existing = await mgr.findOne(ProductionJob, { where: { order_id: order.id } });
    if (existing) return [];

    // Fetch backlog once for all items — it doesn't change within this synchronous batch.
    const designingBacklog = await this.getStageBacklog(ProductionStage.DESIGNING);

    const jobs: ProductionJob[] = [];
    for (const item of order.items || []) {
      const qty = Number(item.qty);
      const due_date = await this.calculateDueDate(
        ProductionStage.DESIGNING,
        qty,
        order.due_date ?? undefined,
        designingBacklog,
      );
      jobs.push(
        mgr.create(ProductionJob, {
          order_id:      order.id,
          order_item_id: item.id,
          sku:           item.sku       || '',
          item_name:     item.item_name || '',
          qty,
          current_stage: ProductionStage.DESIGNING,
          due_date,
        }),
      );
    }

    if (jobs.length === 0) return [];

    // Save all jobs in one statement — either inside the caller's transaction
    // (em provided) or as a standalone write.
    const saved = await mgr.save(ProductionJob, jobs);

    // Auto-assign only on the standalone path.  Callers that provide em must
    // call autoAssignJob() themselves after their transaction commits.
    if (!em) {
      for (const job of saved) await this.autoAssignJob(job);
    }

    return saved;
  }

  /**
   * Atomically recalculates and applies the correct order status based on
   * the current state of all its production jobs. Safe to call concurrently —
   * the computation and update happen in a single SQL statement, so two
   * parallel completions cannot race.
   *
   * Status rules (CANCELLED jobs are ignored in both directions):
   *   • All non-cancelled jobs are DONE  → READY_FOR_DISPATCH
   *   • Any non-cancelled job is active  → IN_PRODUCTION
   *
   * The WHERE clause restricts updates to orders already in the production
   * lifecycle, so approved/cancelled orders are never accidentally touched.
   * The IS DISTINCT FROM guard makes the call idempotent — if the status is
   * already correct the UPDATE matches zero rows and no event is emitted.
   */
  /**
   * Computes and applies the correct order status atomically.
   * Accepts an optional EntityManager so it can run inside an existing
   * transaction (Fix 3: moveToNextStage wraps save + sync in one tx).
   * Returns the new status and salesman info so the caller can emit events
   * after the transaction commits; returns null when no change was needed.
   */
  private async syncOrderStatus(
    orderId: number,
    em?: EntityManager,
  ): Promise<{ newStatus: string; salesmanId: number | null } | null> {
    const manager = em ?? this.repo.manager;

    const rows: Array<{ new_status: string }> = await manager.query(
      `WITH computed AS (
         SELECT
           CASE
             WHEN COUNT(*) FILTER (WHERE status NOT IN ('DONE', 'CANCELLED')) = 0
                  AND COUNT(*) FILTER (WHERE status = 'DONE') > 0
             THEN 'READY_FOR_DISPATCH'
             ELSE 'IN_PRODUCTION'
           END AS target
         FROM production_jobs
         WHERE order_id = $1
       )
       UPDATE orders
          SET status = computed.target
         FROM computed
        WHERE orders.id = $1
          AND orders.status IN ('APPROVED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH')
          AND orders.status IS DISTINCT FROM computed.target
        RETURNING orders.status AS new_status`,
      [orderId],
    );

    if (!rows.length) return null;

    const newStatus = rows[0].new_status;

    if (newStatus === OrderStatus.READY_FOR_DISPATCH) {
      const salesmanRows: any[] = await manager.query(
        `SELECT salesman_id FROM orders WHERE id = $1`,
        [orderId],
      );
      return { newStatus, salesmanId: salesmanRows[0]?.salesman_id ?? null };
    }

    return { newStatus, salesmanId: null };
  }

  private emitOrderStatusEvents(
    result: { newStatus: string; salesmanId: number | null } | null,
    orderId: number,
  ): void {
    if (!result) return;
    const { newStatus, salesmanId } = result;
    if (newStatus === OrderStatus.READY_FOR_DISPATCH) {
      this.eventEmitter.emit('order.ready_for_dispatch', { orderId, salesmanId });
      if (salesmanId) {
        this.crmWa.sendOrderReady(orderId, salesmanId).catch(() => {});
      }
    } else {
      this.eventEmitter.emit('order.reopened', { orderId });
    }
  }

  async cancelJobsForOrder(orderId: number): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(ProductionJob)
      .set({ status: ProductionJobStatus.CANCELLED })
      .where('order_id = :orderId AND status IN (:...statuses)', {
        orderId,
        statuses: ACTIVE_STATUSES,
      })
      .execute();
  }

  async getJobById(id: number): Promise<ProductionJob | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByOrder(orderId: number): Promise<ProductionJob[]> {
    return this.repo.find({
      where: { order_id: orderId },
      order: { id: 'ASC' },
    });
  }

  async findByStage(stage: ProductionStage): Promise<ProductionJob[]> {
    return this.repo.find({
      where: { current_stage: stage },
      order: { created_at: 'ASC' },
    });
  }

  async findByStatus(status: ProductionJobStatus): Promise<ProductionJob[]> {
    return this.repo.find({
      where: { status },
      order: { created_at: 'ASC' },
    });
  }

  async getStageBacklog(stage: ProductionStage): Promise<number> {
    const rows: { total: string }[] = await this.repo.manager.query(
      `SELECT COALESCE(SUM(qty), 0)::numeric AS total
       FROM production_jobs
       WHERE current_stage = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
      [stage],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getRequiredWorkers(stage: ProductionStage): Promise<{
    stage: string;
    workload: number;
    capacity_per_worker: number;
    workers_required: number;
  }> {
    const workload           = await this.getStageBacklog(stage);
    const capacity_per_worker = STAGE_CAPACITY[stage] ?? 1000;
    const workers_required   = workload === 0 ? 0 : Math.ceil(workload / capacity_per_worker);
    return { stage, workload, capacity_per_worker, workers_required };
  }

  async getLabourSummary() {
    return Promise.all(
      (Object.keys(STAGE_CAPACITY) as ProductionStage[]).map(s => this.getRequiredWorkers(s)),
    );
  }

  async getBacklogDays(stage: ProductionStage): Promise<number> {
    const workload = await this.getStageBacklog(stage);
    const capacity = STAGE_CAPACITY[stage] ?? 1000;
    return workload / capacity;
  }

  async predictStageRisk(stage: ProductionStage): Promise<{
    stage: string;
    backlog_days: number;
    risk: string;
  }> {
    const backlog_days = await this.getBacklogDays(stage);
    const risk = backlog_days > 3 ? 'HIGH' : backlog_days > 1 ? 'MEDIUM' : 'NORMAL';
    return { stage, backlog_days, risk };
  }

  async getPredictionSummary() {
    return Promise.all(
      (Object.keys(STAGE_CAPACITY) as ProductionStage[]).map(s => this.predictStageRisk(s)),
    );
  }

  async getDashboard() {
    const [prediction, workforce, queue, topPerformers] = await Promise.all([
      this.getPredictionSummary(),
      this.getWorkforceSummary(),
      this.findQueue({ limit: 20 }),
      this.getTopPerformers(ProductionStage.LASER),
    ]);

    return { prediction, workforce, queue, topPerformers };
  }

  async predictOrderRisk(orderId: number): Promise<{
    order_id: number;
    days_remaining: number;
    risk: string;
  }> {
    const jobs = await this.repo.find({ where: { order_id: orderId } });

    let minDaysRemaining = Infinity;
    for (const job of jobs) {
      if (!job.due_date) continue;
      const days = (new Date(job.due_date).getTime() - Date.now()) / 86_400_000;
      if (days < minDaysRemaining) minDaysRemaining = days;
    }

    const days_remaining = minDaysRemaining === Infinity ? 0 : minDaysRemaining;
    const risk = days_remaining < 0 ? 'DELAYED' : days_remaining < 2 ? 'AT_RISK' : 'SAFE';
    return { order_id: orderId, days_remaining, risk };
  }

  async getAtRiskJobs(stage: ProductionStage): Promise<ProductionJob[]> {
    return this.repo.find({
      where: { current_stage: stage, status: In(ACTIVE_STATUSES) },
      order: { due_date: 'ASC' },
      take: 5,
    });
  }

  private async escalateJobs(jobs: ProductionJob[], reason: string): Promise<void> {
    const toEscalate = jobs.filter(j => j.priority !== JobPriority.URGENT);
    if (!toEscalate.length) return;

    // Bulk UPDATE instead of one save per job.
    await this.repo.manager.query(
      `UPDATE production_jobs SET priority = 'URGENT'
       WHERE id = ANY($1) AND priority != 'URGENT'`,
      [toEscalate.map(j => j.id)],
    );

    for (const job of toEscalate) {
      this.audit.log({
        entity: 'production_job', entity_id: job.id,
        action: 'AUTO_ESCALATE', actor_type: 'SYSTEM',
        meta: { from: job.priority, to: JobPriority.URGENT, reason },
      });
    }
  }

  private async rebalanceJobs(jobs: ProductionJob[]): Promise<void> {
    if (!jobs.length) return;

    // Clear assignments in bulk, then re-assign in parallel.
    await this.repo.manager.query(
      `UPDATE production_jobs SET assigned_to = NULL WHERE id = ANY($1)`,
      [jobs.map(j => j.id)],
    );

    // Auto-assign runs in parallel — each getBestUser is now a single SQL query.
    for (const job of jobs) {
      job.assigned_to = null;
    }
    await Promise.all(jobs.map(job => this.autoAssignJob(job)));
  }

  async runDecisionEngine(): Promise<void> {
    for (const stage of Object.keys(STAGE_CAPACITY) as ProductionStage[]) {
      const prediction = await this.predictStageRisk(stage);

      if (prediction.risk === 'HIGH') {
        const jobs = await this.getAtRiskJobs(stage);
        await this.escalateJobs(jobs, 'HIGH_RISK');
        await this.rebalanceJobs(jobs);
        const managers = await this.userRepo.find({ where: { role: 'Production Manager' }, select: ['id'] });
        this.crmWa.sendHighRisk(stage, managers.map(m => m.id)).catch(() => {});
        console.log(`HIGH RISK handled for ${stage}`);
        continue;
      }

      if (prediction.risk === 'MEDIUM') {
        const jobs = await this.getAtRiskJobs(stage);
        await this.escalateJobs(jobs.slice(0, 2), 'MEDIUM_RISK');
      }
    }
  }

  @Cron('*/10 * * * *')
  async handleDecisionEngine(): Promise<void> {
    if (!ENABLE_DECISION_ENGINE) return;
    await this.runDecisionEngine();
  }

  async getAvailableWorkers(stage: ProductionStage): Promise<number> {
    const role = STAGE_ROLE_MAP[stage];
    if (!role) return 0;
    const rows: { count: string }[] = await this.userRepo.manager.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE LOWER(role) = LOWER($1) AND is_active = true`,
      [role],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async getStageGap(stage: ProductionStage): Promise<{
    stage: string;
    required: number;
    available: number;
    shortage: number;
    surplus: number;
  }> {
    const [{ workers_required }, available] = await Promise.all([
      this.getRequiredWorkers(stage),
      this.getAvailableWorkers(stage),
    ]);
    return {
      stage,
      required:  workers_required,
      available,
      shortage:  Math.max(workers_required - available, 0),
      surplus:   Math.max(available - workers_required, 0),
    };
  }

  async getWorkforceSummary() {
    return Promise.all(
      (Object.keys(STAGE_CAPACITY) as ProductionStage[]).map(s => this.getStageGap(s)),
    );
  }

  async getStageUsers(stage: ProductionStage): Promise<{ id: number }[]> {
    const role = STAGE_ROLE_MAP[stage];
    if (!role) return [];
    // Case-insensitive match so that 'Designer', 'DESIGNER', 'designer' all resolve correctly.
    return this.userRepo.manager.query(
      `SELECT id FROM users WHERE LOWER(role) = LOWER($1) AND is_active = true`,
      [role],
    );
  }

  async getUserLoad(userId: number, stage: ProductionStage): Promise<number> {
    return this.repo.count({
      where: { assigned_to: userId, current_stage: stage, status: In(ACTIVE_STATUSES) },
    });
  }

  async getLeastLoadedUser(stage: ProductionStage): Promise<number | null> {
    return this.getBestUser(stage, JobPriority.NORMAL);
  }

  calculatePerformance(job: ProductionJob): number | null {
    if (!job.started_at || !job.completed_at) return null;
    const actualHours   = (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 3_600_000;
    if (actualHours <= 0) return null;
    const capacity      = STAGE_CAPACITY[job.current_stage] ?? 1000;
    const expectedHours = (job.qty / capacity) * 24;
    return expectedHours / actualHours;
  }

  async getUserEfficiency(userId: number, stage: ProductionStage): Promise<number> {
    const record = await this.effRepo.findOne({ where: { user_id: userId, stage } });
    return record?.efficiency ?? 1;
  }

  async updateUserEfficiency(job: ProductionJob): Promise<void> {
    const performance = this.calculatePerformance(job);
    if (!performance || !job.assigned_to) return;

    const { assigned_to: userId, current_stage: stage } = job;

    let record = await this.effRepo.findOne({ where: { user_id: userId, stage } });
    if (!record) {
      record = this.effRepo.create({ user_id: userId, stage, efficiency: 1 });
    }

    record.efficiency = Math.min(Math.max((record.efficiency * 0.8) + (performance * 0.2), 0.5), 2);
    await this.effRepo.save(record);
  }

  async getEffectiveLoad(userId: number, stage: ProductionStage): Promise<number> {
    const [load, efficiency] = await Promise.all([
      this.getUserLoad(userId, stage),
      this.getUserEfficiency(userId, stage),
    ]);
    return load / efficiency;
  }

  async getTopPerformers(stage: ProductionStage): Promise<ProductionEfficiency[]> {
    return this.effRepo.find({
      where: { stage },
      order: { efficiency: 'DESC' },
      take: 5,
    });
  }

  async getStagePerformance(stage: ProductionStage): Promise<{
    stage: string;
    avg_efficiency: number;
    workers: number;
  }> {
    const records = await this.effRepo.find({ where: { stage } });
    const avg = records.reduce((sum, r) => sum + r.efficiency, 0) / (records.length || 1);
    return { stage, avg_efficiency: avg, workers: records.length };
  }

  async getBestUser(stage: ProductionStage, priority: JobPriority): Promise<number | null> {
    const role = STAGE_ROLE_MAP[stage];
    if (!role) return null;

    // Single query: join users → active jobs for this stage → efficiency record.
    // Sorts by effective load (load / efficiency for URGENT, raw load otherwise)
    // so the least-loaded worker is always first. Replaces the previous N+1 loop.
    const rows: { id: number }[] = await this.repo.manager.query(
      `SELECT u.id
       FROM users u
       LEFT JOIN production_jobs j
         ON j.assigned_to = u.id
        AND j.status IN ('PENDING', 'IN_PROGRESS')
        AND j.current_stage = $2
       LEFT JOIN production_efficiency e
         ON e.user_id = u.id AND e.stage = $2
       WHERE LOWER(u.role) = LOWER($1) AND u.is_active = true
       GROUP BY u.id, e.efficiency
       ORDER BY (
         COUNT(j.id)::float
         / CASE WHEN $3 THEN COALESCE(e.efficiency, 1.0) ELSE 1.0 END
       ) ASC
       LIMIT 1`,
      [role, stage, priority === JobPriority.URGENT],
    );

    return rows[0]?.id ?? null;
  }

  async autoAssignJob(job: ProductionJob): Promise<ProductionJob> {
    if (job.assigned_to) return job;
    const userId = await this.getBestUser(job.current_stage, job.priority);
    if (!userId) {
      this.audit.log({
        entity:     'production_job',
        entity_id:  job.id,
        action:     'AUTO_ASSIGN_FAILED',
        actor_type: 'SYSTEM',
        meta:       { stage: job.current_stage, reason: 'no_eligible_staff' },
      });
      return job;
    }
    job.assigned_to = userId;
    await this.repo.save(job);
    this.audit.log({
      entity: 'production_job', entity_id: job.id,
      action: 'AUTO_ASSIGN', actor_type: 'SYSTEM',
      meta: { assigned_to: userId, stage: job.current_stage },
    });
    this.crmWa.sendJobAssigned(job).catch(() => {});
    this.eventEmitter.emit('job.assigned', job);
    return job;
  }

  private calculateDays(qty: number, capacity: number): number {
    return Math.ceil(qty / capacity);
  }

  async calculateDueDate(
    stage: ProductionStage,
    qty: number,
    deliveryDate?: Date,
    precomputedBacklog?: number,
  ): Promise<Date> {
    const capacity  = STAGE_CAPACITY[stage] ?? 1000;
    const backlog   = precomputedBacklog ?? await this.getStageBacklog(stage);
    const days      = this.calculateDays(backlog + qty, capacity);

    const computed = new Date();
    computed.setDate(computed.getDate() + days);

    if (deliveryDate && new Date(deliveryDate) < computed) {
      return new Date(deliveryDate);
    }
    return computed;
  }

  private isDelayed(job: ProductionJob): boolean {
    if (!job.due_date) return false;
    return new Date() > new Date(job.due_date);
  }

  private hoursOverdue(job: ProductionJob): number {
    if (!job.due_date) return 0;
    return (Date.now() - new Date(job.due_date).getTime()) / 3_600_000;
  }

  private async alreadyAlerted(jobId: number, userId: number): Promise<boolean> {
    const record = await this.alertRepo.findOne({
      where: { job_id: jobId, notified_to: userId, alert_type: 'DELAY' },
    });
    return !!record;
  }

  private async sendAlert(jobId: number, userId: number): Promise<void> {
    if (await this.alreadyAlerted(jobId, userId)) return;
    await this.alertRepo.save({ job_id: jobId, alert_type: 'DELAY', notified_to: userId });
    console.log(`ALERT: Job ${jobId} delayed for user ${userId}`);
  }

  @Cron('*/5 * * * *')
  async checkDelayedJobs(): Promise<void> {
    // Only load jobs that are actually overdue — previously loaded ALL active jobs.
    // Batch-fetch existing DELAY alerts in a single query so we avoid N alreadyAlerted() calls.
    const overdueJobs: Array<{
      id: number; assigned_to: number | null; current_stage: string; hours_overdue: number;
    }> = await this.repo.manager.query(
      `SELECT id, assigned_to, current_stage,
              EXTRACT(EPOCH FROM (NOW() - due_date)) / 3600 AS hours_overdue
       FROM production_jobs
       WHERE status IN ('PENDING', 'IN_PROGRESS')
         AND due_date IS NOT NULL
         AND due_date < NOW()`,
    );

    if (!overdueJobs.length) return;

    const jobIds = overdueJobs.map(j => j.id);

    // Single query to find which (job_id, notified_to) pairs already have a DELAY alert.
    const existingAlerts: Array<{ job_id: number; notified_to: number }> =
      await this.repo.manager.query(
        `SELECT job_id, notified_to FROM production_alerts
         WHERE job_id = ANY($1) AND alert_type = 'DELAY'`,
        [jobIds],
      );

    const alerted = new Set(existingAlerts.map(a => `${a.job_id}:${a.notified_to}`));
    const newAlerts: Array<{ job_id: number; alert_type: string; notified_to: number }> = [];

    for (const job of overdueJobs) {
      if (job.assigned_to && !alerted.has(`${job.id}:${job.assigned_to}`)) {
        newAlerts.push({ job_id: job.id, alert_type: 'DELAY', notified_to: job.assigned_to });
        this.crmWa.sendDelayAlert(job as any).catch(() => {});
      }
      if (job.hours_overdue >= ESCALATION_HOURS && !alerted.has(`${job.id}:${ESCALATION_ADMIN_ID}`)) {
        newAlerts.push({ job_id: job.id, alert_type: 'DELAY', notified_to: ESCALATION_ADMIN_ID });
      }
    }

    if (newAlerts.length) {
      await this.alertRepo.save(newAlerts);
    }
  }

  async getDelayed(limit: number): Promise<(ProductionJob & { is_delayed: boolean })[]> {
    const jobs: ProductionJob[] = await this.repo.manager.query(
      `SELECT * FROM production_jobs
       WHERE status IN ('PENDING', 'IN_PROGRESS')
         AND due_date IS NOT NULL
         AND due_date < NOW()
       ORDER BY due_date ASC
       LIMIT $1`,
      [limit],
    );
    return jobs.map(job => ({ ...job, is_delayed: true }));
  }

  async findQueue(filters: {
    stage?: ProductionStage;
    status?: ProductionJobStatus;
    assigned_to?: number;
    unassigned?: boolean;
    limit?: number;
  }): Promise<(ProductionJob & { is_delayed: boolean })[]> {
    const qb = this.repo.createQueryBuilder('job');

    if (filters.stage)       qb.andWhere('job.current_stage = :stage',    { stage: filters.stage });
    if (filters.status)      qb.andWhere('job.status = :status',           { status: filters.status });
    if (filters.assigned_to) qb.andWhere('job.assigned_to = :assigned_to', { assigned_to: filters.assigned_to });
    if (filters.unassigned)  qb.andWhere('job.assigned_to IS NULL');
    if (filters.limit)       qb.take(filters.limit);

    qb.orderBy(`CASE job.priority
        WHEN 'URGENT' THEN 1
        WHEN 'HIGH'   THEN 2
        WHEN 'NORMAL' THEN 3
        WHEN 'LOW'    THEN 4
      END`, 'ASC')
      .addOrderBy('job.created_at', 'ASC');

    const jobs = await qb.getMany();
    return jobs.map(job => ({ ...job, is_delayed: this.isDelayed(job) }));
  }

  async startJob(jobId: number): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status === ProductionJobStatus.DONE || job.status === ProductionJobStatus.CANCELLED)
      throw new BadRequestException(`Cannot start a ${job.status} job`);
    if (job.status === ProductionJobStatus.IN_PROGRESS) return job; // idempotent
    job.status     = ProductionJobStatus.IN_PROGRESS;
    if (!job.started_at) job.started_at = new Date(); // first start only; restarts after hold keep the original timestamp
    return this.repo.save(job);
  }

  async stopJob(jobId: number): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== ProductionJobStatus.IN_PROGRESS) return job; // idempotent
    job.status = ProductionJobStatus.PENDING;
    return this.repo.save(job);
  }

  async holdJob(jobId: number): Promise<ProductionJob> {
    return this.stopJob(jobId); // hold = pause; same state change
  }

  async reportIssue(jobId: number, note: string, userId?: number): Promise<void> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    await this.alertRepo.save({
      job_id:      jobId,
      alert_type:  'ISSUE',
      notified_to: ESCALATION_ADMIN_ID,
    });
    this.audit.log({
      entity: 'production_job', entity_id: jobId,
      action: 'ISSUE_REPORTED', user_id: userId,
      meta:   { note, stage: job.current_stage },
    });
  }

  async setPriority(jobId: number, priority: JobPriority): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    job.priority = priority;
    return this.repo.save(job);
  }

  async assignJob(jobId: number, userId: number): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    job.assigned_to = userId;
    return this.repo.save(job);
  }

  async findByAssignee(userId: number): Promise<ProductionJob[]> {
    return this.repo.find({
      where: { assigned_to: userId },
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Orders approved more than `thresholdHours` ago that have no IN_PROGRESS or DONE jobs.
   * Used by the dashboard to surface stuck orders before a manager notices manually.
   */
  async getStaleApprovedOrders(thresholdHours = 4): Promise<any[]> {
    return this.repo.manager.query(
      `SELECT
         o.id,
         o.order_no,
         o.customer_name,
         o.approved_at,
         EXTRACT(EPOCH FROM (NOW() - o.approved_at)) / 3600 AS hours_since_approval,
         COUNT(j.id)                                          AS total_jobs,
         COUNT(j.id) FILTER (WHERE j.status = 'PENDING')     AS pending_jobs,
         COUNT(j.id) FILTER (WHERE j.assigned_to IS NULL)    AS unassigned_jobs
       FROM orders o
       LEFT JOIN production_jobs j ON j.order_id = o.id
       WHERE o.status = 'APPROVED'
         AND o.approved_at < NOW() - ($1 || ' hours')::interval
       GROUP BY o.id, o.order_no, o.customer_name, o.approved_at
       HAVING COUNT(j.id) FILTER (WHERE j.status IN ('IN_PROGRESS', 'DONE')) = 0
       ORDER BY o.approved_at ASC`,
      [thresholdHours],
    );
  }

  async getStageSummary(): Promise<{ stage: string; count: string }[]> {
    return this.repo
      .createQueryBuilder('job')
      .select('job.current_stage', 'stage')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.current_stage')
      .getRawMany();
  }

  async moveToNextStage(jobId: number): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    const currentIndex = STAGE_FLOW.indexOf(job.current_stage);
    if (currentIndex === -1) throw new BadRequestException('Invalid stage');
    if (job.current_stage === ProductionStage.COMPLETED) {
      throw new BadRequestException('Job already completed');
    }
    if (job.status !== ProductionJobStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Job must be IN_PROGRESS to complete. Current status: ${job.status}. Use Start first.`,
      );
    }

    const nextStage = STAGE_FLOW[currentIndex + 1];
    job.current_stage = nextStage;
    job.status = nextStage === ProductionStage.COMPLETED
      ? ProductionJobStatus.DONE
      : ProductionJobStatus.IN_PROGRESS;

    if (nextStage === ProductionStage.COMPLETED) {
      job.completed_at = new Date();

      // Atomic: mark job DONE and sync order status in a single transaction so
      // a failure between the two statements cannot leave job=DONE order=IN_PRODUCTION.
      let syncResult: Awaited<ReturnType<typeof this.syncOrderStatus>> = null;
      await this.repo.manager.transaction(async (em) => {
        await em.save(ProductionJob, job);
        syncResult = await this.syncOrderStatus(job.order_id, em);
      });

      // Events fire after the transaction commits so they are never sent for
      // a rolled-back write.
      await this.updateUserEfficiency(job);
      this.eventEmitter.emit('job.completed', job);
      this.emitOrderStatusEvents(syncResult, job.order_id);

      return job;
    }

    job.started_at  = new Date();
    job.due_date    = await this.calculateDueDate(nextStage, job.qty);
    job.assigned_to = null;
    await this.repo.save(job);
    return this.autoAssignJob(job);
  }

  // Admin-only: jump to any stage (e.g. to correct a mis-advance).
  async moveToStage(jobId: number, stage: ProductionStage): Promise<ProductionJob> {
    const job = await this.repo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (!STAGE_FLOW.includes(stage)) throw new BadRequestException(`Invalid stage: ${stage}`);

    // Reopening a job on a dispatched/completed order would create an active production
    // job that syncOrderStatus can never resolve (it only handles APPROVED/IN_PRODUCTION/
    // READY_FOR_DISPATCH). Block the operation so the order status stays coherent.
    if (stage !== ProductionStage.COMPLETED) {
      const orderRows: any[] = await this.repo.manager.query(
        `SELECT status FROM orders WHERE id = $1`,
        [job.order_id],
      );
      const orderStatus = orderRows[0]?.status;
      if (orderStatus === 'DISPATCHED' || orderStatus === 'COMPLETED' || orderStatus === 'CANCELLED') {
        throw new BadRequestException(
          `Cannot reopen a production job when the order is ${orderStatus}`,
        );
      }
    }

    job.current_stage = stage;

    if (stage === ProductionStage.COMPLETED) {
      job.status       = ProductionJobStatus.DONE;
      job.completed_at = job.completed_at ?? new Date();
    } else {
      // Job is being re-opened — clear completion timestamp so elapsed timers
      // restart correctly and the order can revert to IN_PRODUCTION.
      job.status       = stage === ProductionStage.DESIGNING
        ? ProductionJobStatus.PENDING
        : ProductionJobStatus.IN_PROGRESS;
      job.completed_at = null;
    }

    await this.repo.save(job);
    const syncResult = await this.syncOrderStatus(job.order_id);
    this.emitOrderStatusEvents(syncResult, job.order_id);
    return job;
  }
}

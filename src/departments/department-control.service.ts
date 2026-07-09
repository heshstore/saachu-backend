import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { DepartmentExtension } from './entities/department-extension.entity';
import { DepartmentChecklist } from './entities/department-checklist.entity';
import { DepartmentChecklistItem } from './entities/department-checklist-item.entity';
import { DepartmentChecklistSession } from './entities/department-checklist-session.entity';
import { DepartmentChecklistCompletion } from './entities/department-checklist-completion.entity';
import { DepartmentMachine } from './entities/department-machine.entity';
import { DepartmentMaintenance } from './entities/department-maintenance.entity';
import { DepartmentSkill } from './entities/department-skill.entity';
import { DepartmentKpi } from './entities/department-kpi.entity';
import { DepartmentKra } from './entities/department-kra.entity';
import { DepartmentDocument } from './entities/department-document.entity';

@Injectable()
export class DepartmentControlService {
  constructor(
    @InjectRepository(DepartmentExtension) private readonly extRepo: Repository<DepartmentExtension>,
    @InjectRepository(DepartmentChecklist) private readonly clRepo: Repository<DepartmentChecklist>,
    @InjectRepository(DepartmentChecklistItem) private readonly itemRepo: Repository<DepartmentChecklistItem>,
    @InjectRepository(DepartmentChecklistSession) private readonly sessionRepo: Repository<DepartmentChecklistSession>,
    @InjectRepository(DepartmentChecklistCompletion) private readonly completionRepo: Repository<DepartmentChecklistCompletion>,
    @InjectRepository(DepartmentMachine) private readonly machineRepo: Repository<DepartmentMachine>,
    @InjectRepository(DepartmentMaintenance) private readonly maintRepo: Repository<DepartmentMaintenance>,
    @InjectRepository(DepartmentSkill) private readonly skillRepo: Repository<DepartmentSkill>,
    @InjectRepository(DepartmentKpi) private readonly kpiRepo: Repository<DepartmentKpi>,
    @InjectRepository(DepartmentKra) private readonly kraRepo: Repository<DepartmentKra>,
    @InjectRepository(DepartmentDocument) private readonly docRepo: Repository<DepartmentDocument>,
  ) {}

  // ── Extension (Basic Info + Capacity + Ownership + Rules + Quality) ──────────

  async getExtension(deptId: number): Promise<DepartmentExtension> {
    const ext = await this.extRepo.findOne({ where: { departmentId: deptId } });
    if (ext) return ext;
    return this.extRepo.save(this.extRepo.create({ departmentId: deptId }));
  }

  async updateExtension(deptId: number, data: Partial<DepartmentExtension>): Promise<DepartmentExtension> {
    let ext = await this.extRepo.findOne({ where: { departmentId: deptId } });
    if (!ext) ext = this.extRepo.create({ departmentId: deptId });
    Object.assign(ext, data);
    return this.extRepo.save(ext);
  }

  // ── Full detail (one shot for the frontend) ──────────────────────────────────

  async getDetail(deptId: number) {
    const [ext, checklist, machines, maintenance, skills, kpis, kras, documents, readiness] =
      await Promise.all([
        this.getExtension(deptId),
        this.getChecklist(deptId),
        this.getMachines(deptId),
        this.getMaintenance(deptId),
        this.getSkills(deptId),
        this.getKpis(deptId),
        this.getKras(deptId),
        this.getDocuments(deptId),
        this.getReadiness(deptId),
      ]);
    return { ext, checklist, machines, maintenance, skills, kpis, kras, documents, readiness };
  }

  // ── Checklist management ─────────────────────────────────────────────────────

  async getChecklist(deptId: number) {
    let cl = await this.clRepo.findOne({ where: { departmentId: deptId } });
    if (!cl) cl = await this.clRepo.save(this.clRepo.create({ departmentId: deptId }));
    const items = await this.itemRepo.find({
      where: { checklistId: cl.id },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return { ...cl, items };
  }

  async addChecklistItem(deptId: number, data: { itemText: string; isMandatory?: boolean }): Promise<DepartmentChecklistItem> {
    let cl = await this.clRepo.findOne({ where: { departmentId: deptId } });
    if (!cl) cl = await this.clRepo.save(this.clRepo.create({ departmentId: deptId }));
    const maxOrder = await this.itemRepo
      .createQueryBuilder('i')
      .select('MAX(i.sort_order)', 'max')
      .where('i.checklist_id = :id', { id: cl.id })
      .getRawOne<{ max: string }>();
    const nextOrder = Number(maxOrder?.max ?? -1) + 1;
    return this.itemRepo.save(this.itemRepo.create({
      checklistId: cl.id,
      itemText: data.itemText,
      isMandatory: data.isMandatory !== false,
      sortOrder: nextOrder,
    }));
  }

  async updateChecklistItem(itemId: number, data: Partial<DepartmentChecklistItem>): Promise<DepartmentChecklistItem> {
    const item = await this.itemRepo.findOneBy({ id: itemId });
    if (!item) throw new NotFoundException(`Checklist item ${itemId} not found`);
    Object.assign(item, data);
    return this.itemRepo.save(item);
  }

  async deleteChecklistItem(itemId: number): Promise<void> {
    await this.itemRepo.delete(itemId);
  }

  async reorderChecklistItems(deptId: number, orderedIds: number[]): Promise<void> {
    await Promise.all(
      orderedIds.map((id, idx) => this.itemRepo.update(id, { sortOrder: idx })),
    );
  }

  // ── Daily session (Production Lock) ─────────────────────────────────────────

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async getTodaySession(deptId: number) {
    const date = this.todayStr();
    const session = await this.sessionRepo.findOne({
      where: { departmentId: deptId, sessionDate: date },
    });
    if (!session) return null;
    const completions = await this.completionRepo.find({ where: { sessionId: session.id } });
    return { ...session, completions };
  }

  async startSession(deptId: number, userId: number) {
    const date = this.todayStr();
    const existing = await this.sessionRepo.findOne({ where: { departmentId: deptId, sessionDate: date } });
    if (existing) {
      const completions = await this.completionRepo.find({ where: { sessionId: existing.id } });
      return { ...existing, completions };
    }
    const session = await this.sessionRepo.save(
      this.sessionRepo.create({ departmentId: deptId, sessionDate: date, startedBy: userId }),
    );
    return { ...session, completions: [] };
  }

  async completeItem(sessionId: number, itemId: number, userId: number, notes?: string) {
    const existing = await this.completionRepo.findOne({ where: { sessionId, itemId } });
    if (existing) return existing;
    const completion = await this.completionRepo.save(
      this.completionRepo.create({ sessionId, itemId, completedBy: userId, notes: notes ?? null }),
    );
    await this.updateSessionCompleteness(sessionId);
    return completion;
  }

  async uncompleteItem(sessionId: number, itemId: number): Promise<void> {
    await this.completionRepo.delete({ sessionId, itemId });
    await this.updateSessionCompleteness(sessionId);
  }

  private async updateSessionCompleteness(sessionId: number): Promise<void> {
    const session = await this.sessionRepo.findOneBy({ id: sessionId });
    if (!session) return;
    const cl = await this.clRepo.findOne({ where: { departmentId: session.departmentId } });
    if (!cl) return;
    const mandatoryItems = await this.itemRepo.find({
      where: { checklistId: cl.id, isMandatory: true, isActive: true },
    });
    if (mandatoryItems.length === 0) {
      await this.sessionRepo.update(sessionId, { isComplete: true });
      return;
    }
    const completions = await this.completionRepo.find({ where: { sessionId } });
    const completedIds = new Set(completions.map((c) => c.itemId));
    const allDone = mandatoryItems.every((i) => completedIds.has(i.id));
    await this.sessionRepo.update(sessionId, { isComplete: allDone });
  }

  async approveSession(sessionId: number, userId: number) {
    const session = await this.sessionRepo.findOneBy({ id: sessionId });
    if (!session) throw new NotFoundException('Session not found');
    await this.sessionRepo.update(sessionId, { approvedBy: userId, approvedAt: new Date() });
    return this.sessionRepo.findOneBy({ id: sessionId });
  }

  // ── Production readiness check ───────────────────────────────────────────────

  async getReadiness(deptId: number): Promise<{ ready: boolean; reason: string; session: any }> {
    const cl = await this.clRepo.findOne({ where: { departmentId: deptId } });
    if (!cl) return { ready: true, reason: 'No checklist configured', session: null };

    const activeItems = await this.itemRepo.count({ where: { checklistId: cl.id, isActive: true } });
    if (activeItems === 0) return { ready: true, reason: 'No checklist items configured', session: null };

    const session = await this.getTodaySession(deptId);
    if (!session) return { ready: false, reason: 'Daily checklist not started', session: null };
    if (!session.isComplete) return { ready: false, reason: 'Mandatory checklist items not all completed', session };

    const ext = await this.extRepo.findOne({ where: { departmentId: deptId } });
    if (ext?.requireSupervisorApproval && !session.approvedAt) {
      return { ready: false, reason: 'Awaiting supervisor approval', session };
    }

    return { ready: true, reason: 'Checklist complete', session };
  }

  // ── Machines ─────────────────────────────────────────────────────────────────

  async getMachines(deptId: number): Promise<DepartmentMachine[]> {
    return this.machineRepo.find({ where: { departmentId: deptId, isActive: true }, order: { name: 'ASC' } });
  }

  async addMachine(deptId: number, data: Partial<DepartmentMachine>): Promise<DepartmentMachine> {
    return this.machineRepo.save(this.machineRepo.create({ ...data, departmentId: deptId }));
  }

  async updateMachine(machineId: number, data: Partial<DepartmentMachine>): Promise<DepartmentMachine> {
    const m = await this.machineRepo.findOneBy({ id: machineId });
    if (!m) throw new NotFoundException(`Machine ${machineId} not found`);
    Object.assign(m, data);
    return this.machineRepo.save(m);
  }

  async deleteMachine(machineId: number): Promise<void> {
    await this.machineRepo.update(machineId, { isActive: false });
  }

  // ── Maintenance ──────────────────────────────────────────────────────────────

  async getMaintenance(deptId: number): Promise<DepartmentMaintenance[]> {
    return this.maintRepo.find({ where: { departmentId: deptId, isActive: true }, order: { frequency: 'ASC', taskName: 'ASC' } });
  }

  async addMaintenance(deptId: number, data: Partial<DepartmentMaintenance>): Promise<DepartmentMaintenance> {
    return this.maintRepo.save(this.maintRepo.create({ ...data, departmentId: deptId }));
  }

  async updateMaintenance(id: number, data: Partial<DepartmentMaintenance>): Promise<DepartmentMaintenance> {
    const m = await this.maintRepo.findOneBy({ id });
    if (!m) throw new NotFoundException(`Maintenance schedule ${id} not found`);
    Object.assign(m, data);
    return this.maintRepo.save(m);
  }

  async completeMaintenance(id: number, userId: number): Promise<DepartmentMaintenance> {
    const m = await this.maintRepo.findOneBy({ id });
    if (!m) throw new NotFoundException(`Maintenance schedule ${id} not found`);
    m.lastCompletedAt = new Date();
    m.lastCompletedBy = userId;
    return this.maintRepo.save(m);
  }

  async deleteMaintenance(id: number): Promise<void> {
    await this.maintRepo.update(id, { isActive: false });
  }

  // ── Skills ───────────────────────────────────────────────────────────────────

  async getSkills(deptId: number): Promise<DepartmentSkill[]> {
    return this.skillRepo.find({ where: { departmentId: deptId, isActive: true }, order: { skillName: 'ASC' } });
  }

  async addSkill(deptId: number, skillName: string): Promise<DepartmentSkill> {
    return this.skillRepo.save(this.skillRepo.create({ departmentId: deptId, skillName }));
  }

  async deleteSkill(skillId: number): Promise<void> {
    await this.skillRepo.update(skillId, { isActive: false });
  }

  // ── KPIs ─────────────────────────────────────────────────────────────────────

  async getKpis(deptId: number): Promise<DepartmentKpi[]> {
    return this.kpiRepo.find({ where: { departmentId: deptId, isActive: true }, order: { kpiName: 'ASC' } });
  }

  async addKpi(deptId: number, data: Partial<DepartmentKpi>): Promise<DepartmentKpi> {
    return this.kpiRepo.save(this.kpiRepo.create({ ...data, departmentId: deptId }));
  }

  async updateKpi(id: number, data: Partial<DepartmentKpi>): Promise<DepartmentKpi> {
    const k = await this.kpiRepo.findOneBy({ id });
    if (!k) throw new NotFoundException(`KPI ${id} not found`);
    Object.assign(k, data);
    return this.kpiRepo.save(k);
  }

  async deleteKpi(id: number): Promise<void> {
    await this.kpiRepo.update(id, { isActive: false });
  }

  // ── KRAs ─────────────────────────────────────────────────────────────────────

  async getKras(deptId: number): Promise<DepartmentKra[]> {
    return this.kraRepo.find({ where: { departmentId: deptId, isActive: true }, order: { kraName: 'ASC' } });
  }

  async addKra(deptId: number, data: Partial<DepartmentKra>): Promise<DepartmentKra> {
    return this.kraRepo.save(this.kraRepo.create({ ...data, departmentId: deptId }));
  }

  async deleteKra(id: number): Promise<void> {
    await this.kraRepo.update(id, { isActive: false });
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  async getDocuments(deptId: number): Promise<DepartmentDocument[]> {
    return this.docRepo.find({ where: { departmentId: deptId }, order: { uploadedAt: 'DESC' } });
  }

  async addDocument(deptId: number, data: Partial<DepartmentDocument>, userId: number): Promise<DepartmentDocument> {
    return this.docRepo.save(this.docRepo.create({ ...data, departmentId: deptId, uploadedBy: userId }));
  }

  async deleteDocument(id: number): Promise<void> {
    await this.docRepo.delete(id);
  }

  // ── Dashboard summary ────────────────────────────────────────────────────────

  async getDashboard(deptId: number) {
    const today = this.todayStr();
    const [machines, readiness] = await Promise.all([
      this.machineRepo.find({ where: { departmentId: deptId, isActive: true } }),
      this.getReadiness(deptId),
    ]);

    const jobRows: Array<{ status: string; cnt: string }> = await this.extRepo.manager.query(`
      SELECT pbt.status, COUNT(*) as cnt
      FROM   production_board_tasks pbt
      JOIN   departments d ON d.id = pbt.department_id
      WHERE  pbt.department_id = $1
        AND  DATE(pbt.created_at) = $2
      GROUP  BY pbt.status
    `, [deptId, today]).catch(() => []);

    const jobMap = Object.fromEntries(jobRows.map((r) => [r.status, Number(r.cnt)]));

    return {
      ready: readiness.ready,
      readinessReason: readiness.reason,
      todayJobs: Object.values(jobMap).reduce((a, b) => a + b, 0),
      completedJobs: jobMap['COMPLETED'] ?? 0,
      pendingJobs: (jobMap['WAITING'] ?? 0) + (jobMap['ASSIGNED'] ?? 0),
      inProgressJobs: jobMap['IN_PROGRESS'] ?? 0,
      runningMachines: machines.filter((m) => m.status === 'RUNNING').length,
      idleMachines: machines.filter((m) => m.status === 'IDLE').length,
      maintenanceMachines: machines.filter((m) => m.status === 'MAINTENANCE').length,
      breakdownMachines: machines.filter((m) => m.status === 'BREAKDOWN').length,
      totalMachines: machines.length,
    };
  }
}

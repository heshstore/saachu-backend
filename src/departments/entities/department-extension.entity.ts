import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('department_extensions')
export class DepartmentExtension {
  @PrimaryGeneratedColumn() id: number;

  @Column({ name: 'department_id', unique: true }) departmentId: number;
  @Column({ nullable: true }) description: string | null;
  @Column({ name: 'dept_type', default: 'Production' }) deptType: string;

  @Column({ name: 'working_hours_per_day', type: 'numeric', precision: 4, scale: 1, default: 8 }) workingHoursPerDay: number;
  @Column({ name: 'no_machines', type: 'int', default: 0 }) noMachines: number;
  @Column({ name: 'no_operators', type: 'int', default: 0 }) noOperators: number;
  @Column({ name: 'efficiency_pct', type: 'numeric', precision: 5, scale: 2, default: 85 }) efficiencyPct: number;
  @Column({ name: 'oee_target_pct', type: 'numeric', precision: 5, scale: 2, default: 80 }) oeeTargetPct: number;

  @Column({ name: 'manager_name', nullable: true }) managerName: string | null;
  @Column({ name: 'supervisor_name', nullable: true }) supervisorName: string | null;
  @Column({ name: 'team_leader_name', nullable: true }) teamLeaderName: string | null;

  @Column({ name: 'require_qc', default: false }) requireQc: boolean;
  @Column({ name: 'inspection_type', nullable: true }) inspectionType: string | null;

  @Column({ name: 'allow_parallel_jobs', default: true }) allowParallelJobs: boolean;
  @Column({ name: 'require_supervisor_approval', default: false }) requireSupervisorApproval: boolean;
  @Column({ name: 'require_qc_rule', default: false }) requireQcRule: boolean;
  @Column({ name: 'allow_skip_process', default: false }) allowSkipProcess: boolean;
  @Column({ name: 'allow_overtime', default: false }) allowOvertime: boolean;

  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { ProductionExecutionJob } from './production-execution-job.entity';

export type StageStatus =
  | 'PENDING' | 'READY'
  | 'WORKING' | 'ON_HOLD' | 'STOPPED'
  | 'COMPLETED' | 'CANCELLED';

@Entity('production_job_stages')
export class ProductionJobStage {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ProductionExecutionJob, (j) => j.stages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'production_job_id' })
  job: ProductionExecutionJob;

  @Column({ name: 'production_job_id' })
  productionJobId: number;

  @Column({ name: 'department_id' })
  departmentId: number;

  @Column({ name: 'sequence_no' })
  sequenceNo: number;

  @Column({ default: 'PENDING' })
  status: StageStatus;

  @Column({ name: 'assigned_user_id', type: 'int', nullable: true })
  assignedUserId: number | null;

  @Column({ name: 'planned_qty', type: 'float' })
  plannedQty: number;

  @Column({ name: 'completed_qty', type: 'float', default: 0 })
  completedQty: number;

  @Column({ name: 'rejected_qty', type: 'float', default: 0 })
  rejectedQty: number;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'hold_started_at', type: 'timestamptz', nullable: true })
  holdStartedAt: Date | null;

  @Column({ name: 'total_hold_minutes', type: 'float', default: 0 })
  totalHoldMinutes: number;

  @Column({ name: 'stopped_at', type: 'timestamptz', nullable: true })
  stoppedAt: Date | null;

  @Column({ name: 'actual_working_minutes', type: 'float', default: 0 })
  actualWorkingMinutes: number;

  @Column({ name: 'hold_reason', type: 'text', nullable: true })
  holdReason: string | null;

  @Column({ name: 'moved_by', type: 'int', nullable: true })
  movedBy: number | null;

  @Column({ name: 'moved_at', type: 'timestamptz', nullable: true })
  movedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'wastage_remarks', type: 'text', nullable: true })
  wastageRemarks: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';
import { ProductionJobStage } from './production-job-stage.entity';

// PENDING → READY → IN_PROGRESS → COMPLETED | HOLD | CANCELLED
export type ExecJobStatus = 'PENDING' | 'READY' | 'IN_PROGRESS' | 'HOLD' | 'COMPLETED' | 'CANCELLED';
export type ExecJobPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

@Entity('production_execution_jobs')
export class ProductionExecutionJob {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ name: 'order_item_id' })
  orderItemId: number;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'boq_id' })
  boqId: number;

  @Column({ type: 'float' })
  qty: number;

  @Column({ name: 'completed_qty', type: 'float', default: 0 })
  completedQty: number;

  @Column({ name: 'rejected_qty', type: 'float', default: 0 })
  rejectedQty: number;

  @Column({ default: 'PENDING' })
  status: ExecJobStatus;

  @Column({ default: 'MEDIUM' })
  priority: ExecJobPriority;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @OneToMany(() => ProductionJobStage, (s) => s.job, { eager: true })
  stages: ProductionJobStage[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

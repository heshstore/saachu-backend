import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum ProductionJobStatus {
  PENDING     = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE        = 'DONE',
  CANCELLED   = 'CANCELLED',
}

export const ACTIVE_STATUSES = [
  ProductionJobStatus.PENDING,
  ProductionJobStatus.IN_PROGRESS,
];

export enum ProductionStage {
  DESIGNING = 'DESIGNING',
  PRINTING  = 'PRINTING',
  LASER     = 'LASER',
  ASSEMBLY  = 'ASSEMBLY',
  COMPLETED = 'COMPLETED',
}

export enum JobPriority {
  LOW    = 'LOW',
  NORMAL = 'NORMAL',
  HIGH   = 'HIGH',
  URGENT = 'URGENT',
}

@Entity('production_jobs')
export class ProductionJob {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_production_order')
  @Column()
  order_id: number;

  @Column()
  order_item_id: number;

  @Column({ nullable: true })
  sku: string;

  @Column({ nullable: true })
  item_name: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  qty: number;

  @Column({ type: 'varchar', length: 20, default: ProductionJobStatus.PENDING })
  status: ProductionJobStatus;

  @Index('idx_production_assigned')
  @Column({ nullable: true })
  assigned_to: number;

  @Column({ type: 'varchar', length: 10, default: JobPriority.NORMAL })
  priority: JobPriority;

  @Column({ type: 'timestamptz', nullable: true })
  due_date: Date;

  @Index('idx_production_stage')
  @Column({ type: 'varchar', length: 20, default: ProductionStage.DESIGNING })
  current_stage: ProductionStage;

  @Column({ type: 'timestamptz', nullable: true })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date;

  @CreateDateColumn()
  created_at: Date;
}

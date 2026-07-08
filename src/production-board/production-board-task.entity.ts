import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export type BoardTaskStatus =
  | 'WAITING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ON_HOLD'
  | 'CANCELLED'
  | 'BLOCKED';

export type BoardTaskStage =
  | 'DEPARTMENT'
  | 'PACKING'
  | 'BILLING'
  | 'DONE';

export type BoardTaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type ItemType = 'MANUFACTURING' | 'TRADING' | 'OTHER';

@Entity('production_board_tasks')
export class ProductionBoardTask {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('idx_pbt_order')
  @Column({ name: 'order_id' })
  orderId: number;

  @Index('idx_pbt_order_item')
  @Column({ name: 'order_item_id' })
  orderItemId: number;

  // Item snapshot
  @Column({ name: 'item_name', nullable: true })
  itemName: string;

  @Column({ nullable: true })
  sku: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  qty: number;

  @Column({ nullable: true })
  unit: string;

  @Column({ name: 'item_type', default: 'OTHER' })
  itemType: ItemType;

  @Column({ name: 'customer_name', nullable: true })
  customerName: string;

  @Column({ name: 'order_no', nullable: true })
  orderNo: string;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: Date;

  // Assignment
  @Index('idx_pbt_department')
  @Column({ name: 'department_id', nullable: true })
  departmentId: number;

  @Column({ name: 'department_name', nullable: true })
  departmentName: string;

  // Status
  @Index('idx_pbt_status')
  @Column({ default: 'WAITING' })
  status: BoardTaskStatus;

  @Index('idx_pbt_stage')
  @Column({ default: 'DEPARTMENT' })
  stage: BoardTaskStage;

  // Which step in this item's lifecycle (1=first assignment, 2=second…)
  @Column({ name: 'task_no', default: 1 })
  taskNo: number;

  // IDs of sibling tasks that must be COMPLETED before this one unblocks
  @Column({ name: 'depends_on', type: 'int', array: true, default: [] })
  dependsOn: number[];

  @Column({ default: 'MEDIUM' })
  priority: BoardTaskPriority;

  // Audit
  @Column({ name: 'created_by', nullable: true })
  createdBy: number;

  @Column({ name: 'assigned_by', nullable: true })
  assignedBy: number;

  @Column({ name: 'started_by', nullable: true })
  startedBy: number;

  @Column({ name: 'completed_by', nullable: true })
  completedBy: number;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date;

  @Column({ name: 'held_at', type: 'timestamptz', nullable: true })
  heldAt: Date;

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BoardTaskStatus =
  | 'WAITING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ON_HOLD'
  | 'CANCELLED'
  | 'BLOCKED';

export type BoardTaskStage = 'DEPARTMENT' | 'PACKING' | 'BILLING' | 'DONE';
export type BoardTaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

@Entity('production_board_tasks')
export class ProductionBoardTask {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ name: 'order_item_id' })
  orderItemId: number;

  @Column({ name: 'item_name', type: 'varchar', length: 255, nullable: true })
  itemName: string | null;

  @Column({ name: 'sku', type: 'varchar', length: 100, nullable: true })
  sku: string | null;

  @Column({ name: 'qty', type: 'decimal', precision: 10, scale: 2, default: 1 })
  qty: number;

  @Column({ name: 'unit', type: 'varchar', length: 50, nullable: true })
  unit: string | null;

  @Column({ name: 'item_type', type: 'varchar', length: 30, default: 'OTHER' })
  itemType: string;

  @Column({ name: 'customer_name', type: 'varchar', length: 255, nullable: true })
  customerName: string | null;

  @Column({ name: 'order_no', type: 'varchar', length: 50, nullable: true })
  orderNo: string | null;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: Date | null;

  @Column({ name: 'department_id', type: 'int', nullable: true })
  departmentId: number | null;

  @Column({ name: 'department_name', type: 'varchar', length: 255, nullable: true })
  departmentName: string | null;

  @Column({ default: 'WAITING' })
  status: BoardTaskStatus;

  @Column({ default: 'DEPARTMENT' })
  stage: BoardTaskStage;

  @Column({ name: 'task_no', default: 1 })
  taskNo: number;

  @Column({ name: 'depends_on', type: 'int', array: true, default: '{}' })
  dependsOn: number[];

  @Column({ default: 'MEDIUM' })
  priority: BoardTaskPriority;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'assigned_by', type: 'int', nullable: true })
  assignedBy: number | null;

  @Column({ name: 'started_by', type: 'int', nullable: true })
  startedBy: number | null;

  @Column({ name: 'completed_by', type: 'int', nullable: true })
  completedBy: number | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'held_at', type: 'timestamptz', nullable: true })
  heldAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

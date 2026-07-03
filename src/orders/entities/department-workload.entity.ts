import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('department_workloads')
export class DepartmentWorkload {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ name: 'order_item_id' })
  orderItemId: number;

  @Column({ name: 'department_id' })
  departmentId: number;

  @Column({ name: 'boq_item_id', nullable: true })
  boqItemId: number | null;

  @Column({ name: 'workload_qty', type: 'float' })
  workloadQty: number;

  @Column({ name: 'workload_unit', length: 20 })
  workloadUnit: string;

  @Column({ name: 'estimated_hours', type: 'float', nullable: true })
  estimatedHours: number | null;

  /** PENDING | IN_PROGRESS | DONE */
  @Column({ length: 20, default: 'PENDING' })
  status: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

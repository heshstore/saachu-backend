import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

@Entity('department_cost_master')
export class DepartmentCostMaster {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ name: 'department_id' })
  departmentId: number;

  /** Base shop-floor rate (₹/hour) */
  @Column({ name: 'cost_per_hour', type: 'double precision', default: 0 })
  costPerHour: number;

  /** Additional labour burden (₹/hour) */
  @Column({ name: 'manpower_rate', type: 'double precision', default: 0 })
  manpowerRate: number;

  /** Overhead burden (₹/hour) */
  @Column({ name: 'overhead_rate', type: 'double precision', default: 0 })
  overheadRate: number;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('department_kpis')
export class DepartmentKpi {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ name: 'kpi_name' }) kpiName: string;
  @Column({ name: 'target_value', type: 'numeric', precision: 10, scale: 2, nullable: true }) targetValue: number | null;
  @Column({ nullable: true }) unit: string | null;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

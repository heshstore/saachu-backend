import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type MaintenanceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

@Entity('department_maintenance_schedules')
export class DepartmentMaintenance {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ default: 'DAILY' }) frequency: MaintenanceFrequency;
  @Column({ name: 'task_name' }) taskName: string;
  @Column({ name: 'estimated_minutes', type: 'int', default: 30 }) estimatedMinutes: number;
  @Column({ name: 'responsible_person', nullable: true }) responsiblePerson: string | null;
  @Column({ name: 'last_completed_at', type: 'timestamptz', nullable: true }) lastCompletedAt: Date | null;
  @Column({ name: 'last_completed_by', nullable: true }) lastCompletedBy: number | null;
  @Column({ nullable: true }) notes: string | null;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

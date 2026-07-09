import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { DepartmentChecklistItem } from './department-checklist-item.entity';

@Entity('department_checklists')
export class DepartmentChecklist {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id', unique: true }) departmentId: number;
  @Column({ default: 'Daily Machine Startup Checklist' }) name: string;
  @Column({ name: 'is_active', default: true }) isActive: boolean;

  @OneToMany(() => DepartmentChecklistItem, (i) => i.checklist, { cascade: true, eager: false })
  items: DepartmentChecklistItem[];

  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

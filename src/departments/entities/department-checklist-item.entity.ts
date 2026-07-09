import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { DepartmentChecklist } from './department-checklist.entity';

@Entity('department_checklist_items')
export class DepartmentChecklistItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'checklist_id' }) checklistId: number;
  @Column({ name: 'item_text' }) itemText: string;
  @Column({ name: 'is_mandatory', default: true }) isMandatory: boolean;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @Column({ name: 'sort_order', default: 0 }) sortOrder: number;

  @ManyToOne(() => DepartmentChecklist, (c) => c.items)
  @JoinColumn({ name: 'checklist_id' })
  checklist: DepartmentChecklist;

  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn } from 'typeorm';
import { DepartmentChecklistCompletion } from './department-checklist-completion.entity';

@Entity('department_checklist_sessions')
export class DepartmentChecklistSession {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ name: 'session_date', type: 'date' }) sessionDate: string;
  @Column({ name: 'started_by', nullable: true }) startedBy: number | null;
  @Column({ name: 'is_complete', default: false }) isComplete: boolean;
  @Column({ name: 'approved_by', nullable: true }) approvedBy: number | null;
  @Column({ name: 'approved_at', nullable: true, type: 'timestamptz' }) approvedAt: Date | null;

  @OneToMany(() => DepartmentChecklistCompletion, (c) => c.session, { cascade: true, eager: false })
  completions: DepartmentChecklistCompletion[];

  @CreateDateColumn({ name: 'started_at' }) startedAt: Date;
}

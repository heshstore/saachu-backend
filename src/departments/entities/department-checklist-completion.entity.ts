import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { DepartmentChecklistSession } from './department-checklist-session.entity';

@Entity('department_checklist_completions')
export class DepartmentChecklistCompletion {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'session_id' }) sessionId: number;
  @Column({ name: 'item_id' }) itemId: number;
  @Column({ name: 'completed_by', nullable: true }) completedBy: number | null;
  @Column({ nullable: true }) notes: string | null;

  @ManyToOne(() => DepartmentChecklistSession, (s) => s.completions)
  @JoinColumn({ name: 'session_id' })
  session: DepartmentChecklistSession;

  @CreateDateColumn({ name: 'completed_at' }) completedAt: Date;
}

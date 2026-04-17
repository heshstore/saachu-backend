import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Lead } from './lead.entity';

@Entity('lead_followups')
export class LeadFollowUp {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  lead_id: number;

  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lead_id' })
  lead: Lead;

  @Column({ type: 'timestamptz' })
  due_date: Date;

  @Column({ type: 'text', nullable: true })
  note: string;

  @Column({ default: false })
  is_completed: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date;

  @Column({ nullable: true })
  completed_by: number;

  @Column()
  created_by: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

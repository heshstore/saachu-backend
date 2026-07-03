import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Lead } from './lead.entity';

export enum NoteType {
  CALL = 'CALL',
  EMAIL = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
  GENERAL = 'GENERAL',
  /** Internal/admin notes: automation actions, system events, WA click tracking.
   *  Stored in lead_notes but EXCLUDED from the Customer Journey timeline.
   *  Flows into System Audit via activity_log events. */
  SYSTEM = 'SYSTEM',
}

@Entity('lead_notes')
export class LeadNote {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  lead_id: number;

  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lead_id' })
  lead: Lead;

  @Column({ type: 'text' })
  note: string;

  @Column({ type: 'varchar', length: 20, default: NoteType.GENERAL })
  type: NoteType;

  @Column({ nullable: true })
  created_by: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

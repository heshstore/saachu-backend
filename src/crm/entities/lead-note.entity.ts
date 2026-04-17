import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Lead } from './lead.entity';

export enum NoteType {
  CALL     = 'CALL',
  EMAIL    = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
  GENERAL  = 'GENERAL',
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

  @Column()
  created_by: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

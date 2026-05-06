import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type AlertType =
  | 'NOT_CONTACTED'
  | 'HIGH_PRIORITY_STALE'
  | 'FOLLOWUP_OVERDUE'
  | 'WHATSAPP_DOWN';

@Entity('lead_alerts')
export class LeadAlert {
  @PrimaryGeneratedColumn()
  id: number;

  /** Null for system-level alerts (e.g. WHATSAPP_DOWN) not tied to a specific lead. */
  @Column({ nullable: true, type: 'int' })
  lead_id: number | null;

  @Column({ length: 50 })
  type: AlertType;

  @Column({ type: 'text' })
  message: string;

  @Column({ default: false })
  resolved: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

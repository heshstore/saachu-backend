import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

export type AlertType =
  | 'NOT_CONTACTED'
  | 'HIGH_PRIORITY_STALE'
  | 'FOLLOWUP_OVERDUE'
  | 'WHATSAPP_DOWN';   // system-level — lead_id is null

@Entity('lead_alerts')
export class LeadAlert {
  @PrimaryGeneratedColumn()
  id: number;

  /** Null for system-level alerts (e.g. WHATSAPP_DOWN) that aren't tied to a lead. */
  @Column({ nullable: true })
  lead_id: number | null;

  @Column({ length: 50 })
  type: AlertType;

  @Column({ type: 'text' })
  message: string;

  @Column({ default: false })
  resolved: boolean;

  @CreateDateColumn()
  created_at: Date;
}

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

export type AuditAction =
  | 'VIEWED'
  | 'UPDATED'
  | 'STATUS_CHANGED'
  | 'ASSIGNED'
  | 'CALLED'
  | 'FOLLOWUP_CREATED'
  | 'FOLLOWUP_COMPLETED'
  | 'CONVERTED'
  | 'QUOTATION_CREATED'
  | 'ESCALATED';  // written by automation cron — user_id = SYSTEM_USER_ID (0)

// AUTOMATION AUDITS MUST USE LeadAuditService.log() — DO NOT INSERT INTO lead_audit_logs DIRECTLY.
@Entity('lead_audit_logs')
export class LeadAuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  lead_id: number;

  @Column()
  user_id: number;

  @Column({ length: 50 })
  action: AuditAction;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ip_address: string | null;

  @CreateDateColumn()
  created_at: Date;
}

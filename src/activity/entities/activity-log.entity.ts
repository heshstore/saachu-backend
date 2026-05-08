import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ActivitySource   = 'USER' | 'SYSTEM' | 'AUTOMATION' | 'WHATSAPP';
export type ActivitySeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

@Entity('activity_logs')
@Index('idx_act_module',    ['module'])
@Index('idx_act_entity',    ['entity_type', 'entity_id'])
@Index('idx_act_actor',     ['performed_by_user_id'])
@Index('idx_act_severity',  ['severity'])
@Index('idx_act_created',   ['created_at'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Top-level domain: CRM, PRODUCTION, ACCOUNTS, DISPATCH, SYSTEM, AUTH, SLA
  @Column({ type: 'varchar', length: 20 })
  module: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  entity_type: string | null;

  @Column({ nullable: true })
  entity_id: number | null;

  // Machine-readable verb: LEAD_CREATED, STATUS_CHANGED, PAYMENT_RECEIVED …
  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ nullable: true })
  performed_by_user_id: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  performed_by_name: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  performed_by_role: string | null;

  @Column({ type: 'varchar', length: 15, default: 'SYSTEM' })
  source: ActivitySource;

  // Field-level diffs — only changed fields, NOT full entity dumps
  @Column({ type: 'jsonb', nullable: true })
  old_value: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  new_value: Record<string, any> | null;

  // Extra context (e.g. lead source, order total) — trimmed to ≤4 KB before storing
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ip_address: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  user_agent: string | null;

  // INFO (routine) → WARNING (needs attention) → ERROR (failed) → CRITICAL (breach/down)
  @Column({ type: 'varchar', length: 8, default: 'INFO' })
  severity: ActivitySeverity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type SlaStatus = 'ACTIVE' | 'WARNING' | 'ESCALATED' | 'RESOLVED';
export type SlaModule = 'CRM' | 'PRODUCTION' | 'ACCOUNTS' | 'DISPATCH';
export type SlaPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

@Entity('sla_events')
@Index('idx_sla_status', ['status'])
@Index('idx_sla_entity', ['entity_type', 'entity_id'])
@Index('idx_sla_user', ['assigned_user_id'])
@Index('idx_sla_deadline', ['sla_deadline'])
export class SlaEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 20 })
  module: SlaModule;

  @Column({ type: 'varchar', length: 30 })
  entity_type: string;

  @Column()
  entity_id: number;

  @Column({ type: 'varchar', length: 200 })
  entity_label: string;

  @Column({ nullable: true })
  assigned_user_id: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  assigned_role: string | null;

  // ACTIVE → WARNING (near deadline) → ESCALATED (past deadline) → RESOLVED
  @Column({ type: 'varchar', length: 10, default: 'ACTIVE' })
  status: SlaStatus;

  @Column({ type: 'varchar', length: 8, default: 'MEDIUM' })
  priority: SlaPriority;

  @Column({ type: 'timestamptz' })
  sla_deadline: Date;

  @Column({ type: 'timestamptz', nullable: true })
  warning_at: Date | null;

  // 0 = assigned user, 1 = department manager, 2 = admin
  @Column({ type: 'int', default: 0 })
  escalation_level: number;

  @Column({ type: 'timestamptz', nullable: true })
  escalated_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_notification_at: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

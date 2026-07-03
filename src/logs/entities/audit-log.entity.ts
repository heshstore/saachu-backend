import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('audit_logs')
@Index('idx_audit_entity', ['entity', 'entity_id'])
@Index('idx_audit_user', ['user_id'])
@Index('idx_audit_time', ['created_at'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  entity: string;

  @Column()
  entity_id: number;

  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ nullable: true })
  user_id: number;

  @Column({ type: 'varchar', length: 10, default: 'USER' })
  actor_type: string;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

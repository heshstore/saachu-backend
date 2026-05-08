import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum NotificationType {
  ACTION     = 'ACTION',
  REMINDER   = 'REMINDER',
  INFO       = 'INFO',
  MOTIVATION = 'MOTIVATION',
}

export enum NotificationPriority {
  CRITICAL = 'CRITICAL',
  HIGH     = 'HIGH',
  MEDIUM   = 'MEDIUM',
  LOW      = 'LOW',
}

export enum NotificationCategory {
  CRM        = 'CRM',
  PRODUCTION = 'PRODUCTION',
  ACCOUNTS   = 'ACCOUNTS',
  DISPATCH   = 'DISPATCH',
  SYSTEM     = 'SYSTEM',
}

export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  [NotificationPriority.CRITICAL]: 4,
  [NotificationPriority.HIGH]:     3,
  [NotificationPriority.MEDIUM]:   2,
  [NotificationPriority.LOW]:      1,
};

@Entity('notifications')
@Index('idx_notif_user_read',   ['user_id', 'is_read'])
@Index('idx_notif_user_active', ['user_id', 'is_active'])
@Index('idx_notif_created',     ['created_at'])
@Index('idx_notif_dedup', ['user_id', 'is_active', 'entity_type', 'entity_id', 'type'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: number;

  @Column({ type: 'varchar', length: 12, default: NotificationType.INFO })
  type: NotificationType;

  // varchar(8) fits 'CRITICAL' exactly (8 chars)
  @Column({ type: 'varchar', length: 8, default: NotificationPriority.MEDIUM })
  priority: NotificationPriority;

  @Column({ type: 'varchar', length: 20, nullable: true })
  category: NotificationCategory | null;

  @Column()
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  entity_type: string | null;

  @Column({ nullable: true })
  entity_id: number | null;

  // Direct navigation URL — used by NotificationCenter "Go To" button
  @Column({ type: 'varchar', length: 500, nullable: true })
  action_url: string | null;

  // Comma-separated list of role names this notification was broadcast to
  @Column({ type: 'simple-array', nullable: true })
  role_targets: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ default: false })
  is_read: boolean;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  is_automated: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  // Soft-hide: set by user from center; hides permanently without DB deletion
  @Column({ type: 'timestamptz', nullable: true })
  hidden_at: Date | null;
}

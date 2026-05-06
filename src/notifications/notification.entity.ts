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
  HIGH   = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW    = 'LOW',
}

export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  [NotificationPriority.HIGH]:   3,
  [NotificationPriority.MEDIUM]: 2,
  [NotificationPriority.LOW]:    1,
};

@Entity('notifications')
@Index('idx_notif_user_read',   ['user_id', 'is_read'])
@Index('idx_notif_user_active', ['user_id', 'is_active'])
@Index('idx_notif_created',     ['created_at'])
// Covers the dedup query in createNotification exactly:
// WHERE user_id=$1 AND is_active=true AND entity_type=$2 AND entity_id=$3 AND type=$4 AND created_at > $5
@Index('idx_notif_dedup', ['user_id', 'is_active', 'entity_type', 'entity_id', 'type'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: number;

  @Column({ type: 'varchar', length: 12, default: NotificationType.INFO })
  type: NotificationType;

  @Column({ type: 'varchar', length: 8, default: NotificationPriority.MEDIUM })
  priority: NotificationPriority;

  @Column()
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  entity_type: string;

  @Column({ nullable: true })
  entity_id: number;

  @Column({ default: false })
  is_read: boolean;

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  is_automated: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date;
}

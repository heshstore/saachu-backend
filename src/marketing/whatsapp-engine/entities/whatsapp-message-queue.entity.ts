import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { QueueStatus } from './enums';

@Entity('whatsapp_message_queue')
@Index('idx_wmq_status', ['status'])
@Index('idx_wmq_campaign_id', ['campaign_id'])
@Index('idx_wmq_scheduled_at', ['scheduled_at'])
@Index('idx_wmq_customer_phone', ['customer_phone'])
@Index('idx_wmq_status_scheduled_at', ['status', 'scheduled_at'])
export class WhatsappMessageQueue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  campaign_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  number_id: string | null;

  @Column({ type: 'int', nullable: true })
  customer_id: number | null;

  @Column({ type: 'int', nullable: true })
  product_id: number | null;

  @Column({ type: 'uuid', nullable: true })
  template_id: string | null;

  @Column({ type: 'varchar' })
  customer_phone: string;

  @Column({ type: 'timestamptz' })
  scheduled_at: Date;

  @Column({
    type: 'varchar',
    default: QueueStatus.PENDING,
  })
  status: QueueStatus;

  @Column({ type: 'int', default: 0 })
  attempt_count: number;

  @Column({ type: 'int', default: 5 })
  priority: number;

  @Column({ type: 'jsonb', nullable: true })
  message_payload: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at: Date | null;

  // Actual sender — set at send time, denormalized for historical stability.
  // Survives number renames/deletions; differs from number_id when pool failover kicks in.
  @Column({ type: 'uuid', nullable: true })
  actual_sender_number_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  actual_sender_phone: string | null;

  @Column({ type: 'varchar', nullable: true })
  actual_sender_name: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

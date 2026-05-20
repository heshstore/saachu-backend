import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { MessageType, QueueStatus } from './enums';

@Entity('whatsapp_message_logs')
@Index('idx_wml_campaign_id', ['campaign_id'])
@Index('idx_wml_customer_phone', ['customer_phone'])
@Index('idx_wml_wa_message_id', ['wa_message_id'])
export class WhatsappMessageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  campaign_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  queue_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  number_id: string | null;

  @Column({ type: 'varchar' })
  customer_phone: string;

  @Column({
    type: 'varchar',
    default: MessageType.TEXT,
  })
  message_type: MessageType;

  @Column({ type: 'text', nullable: true })
  message_body: string | null;

  @Column({ type: 'varchar', nullable: true })
  media_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  wa_message_id: string | null;

  @Column({
    type: 'varchar',
    default: QueueStatus.SENT,
  })
  status: QueueStatus;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date | null;

  @Column({ type: 'boolean', default: false })
  reply_received: boolean;

  @Column({ type: 'text', nullable: true })
  reply_message: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

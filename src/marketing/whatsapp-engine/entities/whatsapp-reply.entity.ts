import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { MessageType } from './enums';

@Entity('whatsapp_replies')
@Index('idx_wr_customer_phone', ['customer_phone'])
@Index('idx_wr_crm_lead_created', ['crm_lead_created'])
@Index('idx_wr_conversation_key', ['conversation_key'])
export class WhatsappReply {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  number_id: string | null;

  @Column({ type: 'varchar' })
  customer_phone: string;

  @Column({ type: 'varchar', nullable: true })
  customer_name: string | null;

  // normalized_sender_phone|number_id — groups all messages in one thread
  @Column({ type: 'varchar', nullable: true })
  conversation_key: string | null;

  @Column({ type: 'text' })
  message: string;

  @Column({
    type: 'varchar',
    default: MessageType.TEXT,
  })
  message_type: MessageType;

  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @Column({ type: 'boolean', default: false })
  crm_lead_created: boolean;

  @Column({ type: 'int', nullable: true })
  crm_lead_id: number | null;

  @Column({ type: 'timestamptz' })
  received_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

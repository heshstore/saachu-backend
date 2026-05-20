import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { WhatsAppNumberStatus } from './enums';

@Entity('whatsapp_numbers')
@Index('idx_wn_status', ['status'])
@Index('idx_wn_is_active', ['is_active'])
export class WhatsappNumber {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Index('idx_wn_phone_unique', { unique: true })
  @Column({ type: 'varchar', unique: true })
  phone: string;

  @Column({
    type: 'varchar',
    default: WhatsAppNumberStatus.ACTIVE,
  })
  status: WhatsAppNumberStatus;

  @Column({ type: 'varchar', nullable: true })
  wa_state: string | null;

  @Column({ type: 'int', default: 50 })
  daily_limit: number;

  @Column({ type: 'int', default: 0 })
  daily_sent: number;

  @Column({ type: 'int', default: 1 })
  warmup_level: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  risk_score: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_connected_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_message_sent_at: Date | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ReplyStatus } from './enums';

@Entity('marketing_audience')
@Index('idx_ma_customer_id', ['customer_id'])
@Index('idx_ma_opt_out', ['opt_out'])
@Index('idx_ma_reply_status', ['reply_status'])
export class MarketingAudience {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', nullable: true })
  customer_id: number | null;

  // phone = mobile_1 (WhatsApp dedup key). Nullable so email-only contacts can be stored.
  // PostgreSQL unique index treats NULLs as distinct — multiple null phones do not conflict.
  @Index('idx_ma_phone_unique', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true })
  mobile_2: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  customer_name: string | null;

  @Column({ type: 'varchar', nullable: true })
  company: string | null;

  // Legacy alias kept for existing campaign/queue logic that references `name`
  @Column({ type: 'varchar', nullable: true })
  name: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'varchar', nullable: true })
  city: string | null;

  @Column({ type: 'varchar', nullable: true })
  state: string | null;

  @Column({ type: 'varchar', nullable: true })
  country: string | null;

  @Column({ type: 'varchar', nullable: true })
  gst: string | null;

  @Column({ type: 'varchar', nullable: true })
  business_type: string | null;

  @Column({ type: 'varchar', nullable: true })
  source: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  quality_score: number;

  @Column({ type: 'boolean', default: true })
  is_whatsapp_valid: boolean;

  @Column({ type: 'boolean', default: false })
  opt_out: boolean;

  @Column({ type: 'boolean', default: false })
  is_test_contact: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  cooldown_until: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_contacted_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_reply_at: Date | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  fatigue_score: number;

  @Column({
    type: 'varchar',
    default: ReplyStatus.NONE,
  })
  reply_status: ReplyStatus;

  // Set to 'NOT_REGISTERED' when a send attempt returns INVALID_WA_NUMBER.
  // Future campaign builders automatically exclude these contacts via findEligible().
  @Column({ type: 'varchar', nullable: true })
  wa_registration_status: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_validation_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

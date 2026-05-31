import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { CTAType, MessageType, TemplateMode } from './enums';

@Entity('marketing_templates')
@Index('idx_mt_is_active', ['is_active'])
export class MarketingTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  template_name: string;

  @Column({
    type: 'varchar',
    default: MessageType.TEXT,
  })
  message_type: MessageType;

  @Column({ type: 'text' })
  message_body: string;

  @Column({
    type: 'varchar',
    default: CTAType.NONE,
  })
  cta_type: CTAType;

  @Column({ type: 'varchar', nullable: true })
  cta_label: string | null;

  @Column({ type: 'varchar', nullable: true })
  cta_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  media_type: string | null;

  @Column({ type: 'varchar', nullable: true })
  media_url: string | null;

  @Column({ type: 'varchar', nullable: true })
  product_category: string | null;

  @Column({ type: 'varchar', default: TemplateMode.MANUAL })
  template_mode: TemplateMode;

  @Column({ type: 'boolean', default: false })
  offer_enabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  offer_title: string | null;

  @Column({ type: 'text', nullable: true })
  offer_text: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  offer_start_date: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  offer_end_date: Date | null;

  @Column({ type: 'boolean', default: false })
  is_auto: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1.0 })
  performance_weight: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

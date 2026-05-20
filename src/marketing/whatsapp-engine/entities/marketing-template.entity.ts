import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { CTAType, MessageType } from './enums';

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

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1.0 })
  performance_weight: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

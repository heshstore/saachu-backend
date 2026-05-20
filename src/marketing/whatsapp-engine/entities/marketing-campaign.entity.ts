import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { CampaignStatus } from './enums';

@Entity('marketing_campaigns')
@Index('idx_mc_status', ['status'])
@Index('idx_mc_created_by', ['created_by'])
export class MarketingCampaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  campaign_name: string;

  @Column({ type: 'varchar', default: 'broadcast' })
  campaign_type: string;

  @Column({
    type: 'varchar',
    default: CampaignStatus.DRAFT,
  })
  status: CampaignStatus;

  @Column({ type: 'int', default: 100 })
  daily_target: number;

  @Column({ type: 'varchar', default: '09:00' })
  send_window_start: string;

  @Column({ type: 'varchar', default: '18:00' })
  send_window_end: string;

  @Column({ type: 'int', default: 30 })
  random_delay_min: number;

  @Column({ type: 'int', default: 120 })
  random_delay_max: number;

  @Column({ type: 'uuid', nullable: true })
  template_id: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'int', nullable: true })
  created_by: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

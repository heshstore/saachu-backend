import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('analytics_events')
export class AnalyticsEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  session_id: string;

  @Column({ type: 'text' })
  event: string;

  @Column({ type: 'text', nullable: true })
  product: string;

  @Column({ type: 'text' })
  page_url: string;

  @Column({ type: 'text', nullable: true })
  device: string;

  @Column({ type: 'text', nullable: true })
  city: string;

  @Column({ type: 'text', nullable: true })
  source: string;

  @Column({ type: 'timestamp', nullable: true })
  timestamp: Date;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('analytics_events')
export class AnalyticsEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  session_id: string;

  @Column({ type: 'varchar', length: 255 })
  event: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  product: string;

  @Column({ type: 'text' })
  page_url: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}

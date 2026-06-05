import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('pilot_daily_metrics')
@Index('idx_pdm_date', ['date'], { unique: true })
export class PilotDailyMetrics {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'date' })
  date: Date;

  @Column({ type: 'int', default: 0 }) sent_count:     number;
  @Column({ type: 'int', default: 0 }) delivered_count: number;
  @Column({ type: 'int', default: 0 }) read_count:      number;
  @Column({ type: 'int', default: 0 }) replied_count:   number;
  @Column({ type: 'int', default: 0 }) failed_count:    number;
  @Column({ type: 'int', default: 0 }) skipped_count:   number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 }) delivery_rate_pct: number;
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 }) read_rate_pct:     number;
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 }) reply_rate_pct:    number;
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 }) failure_rate_pct:  number;

  @Column({ type: 'int', default: 0 }) active_numbers:    number;
  @Column({ type: 'int', default: 0 }) connected_numbers: number;
  @Column({ type: 'int', default: 0 }) queue_backlog:     number;

  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}

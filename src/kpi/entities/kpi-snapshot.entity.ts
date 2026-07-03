import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export type KpiScope = 'USER' | 'TEAM' | 'SYSTEM';
export type KpiPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';

@Entity('kpi_snapshots')
@Index('idx_kpi_scope', ['scope', 'scope_id'])
@Index('idx_kpi_module', ['module'])
@Index('idx_kpi_metric', ['metric_key'])
@Index('idx_kpi_period', ['period'])
@Index('idx_kpi_period_start', ['period_start'])
// Unique prevents duplicate snapshots for the same metric/scope/period
@Unique('uq_kpi_snapshot', [
  'scope',
  'scope_id',
  'module',
  'metric_key',
  'period',
  'period_start',
])
export class KpiSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // USER = per-person metric, TEAM = role group, SYSTEM = company-wide
  @Column({ type: 'varchar', length: 10 })
  scope: KpiScope;

  // user.id or null for SYSTEM/TEAM scopes
  @Column({ nullable: true })
  scope_id: number | null;

  @Column({ type: 'varchar', length: 20 })
  module: string;

  // e.g. 'avg_response_minutes', 'sla_compliance_rate', 'jobs_completed'
  @Column({ type: 'varchar', length: 60 })
  metric_key: string;

  @Column({ type: 'numeric', precision: 14, scale: 4 })
  metric_value: number;

  // 'minutes', '%', 'count', 'hours', 'INR'
  @Column({ type: 'varchar', length: 20, nullable: true })
  metric_unit: string | null;

  @Column({ type: 'varchar', length: 10 })
  period: KpiPeriod;

  @Column({ type: 'timestamptz' })
  period_start: Date;

  @Column({ type: 'timestamptz' })
  period_end: Date;

  // Extra context: sample_size, sources, thresholds
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('production_alerts')
@Index('idx_alert_lookup', ['job_id', 'notified_to', 'alert_type'])
export class ProductionAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  job_id: number;

  @Column({ type: 'varchar', length: 20 })
  alert_type: string;

  @Column()
  notified_to: number;

  @CreateDateColumn()
  created_at: Date;
}

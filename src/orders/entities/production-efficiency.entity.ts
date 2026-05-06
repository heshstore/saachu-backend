import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  UpdateDateColumn,
} from 'typeorm';

@Entity('production_efficiency')
@Index('idx_efficiency_user_stage', ['user_id', 'stage'], { unique: true })
export class ProductionEfficiency {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number;

  @Column({ type: 'varchar', length: 20 })
  stage: string;

  @Column({ type: 'float', default: 1 })
  efficiency: number;

  @UpdateDateColumn()
  updated_at: Date;
}

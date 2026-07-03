import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AmcContractStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

@Entity('amc_contracts')
export class AmcContract {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'customer_id' })
  customerId: number;

  @Column({ name: 'order_id', type: 'int', nullable: true })
  orderId: number | null;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @Column({ name: 'visit_frequency', length: 40, nullable: true })
  visitFrequency: string | null;

  /** JSON array of service_items ids covered by this AMC */
  @Column({ name: 'covered_items', type: 'jsonb', default: () => "'[]'" })
  coveredItems: number[];

  @Column({ default: 'ACTIVE' })
  status: AmcContractStatus;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

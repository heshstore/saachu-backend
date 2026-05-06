import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum DispatchStatus {
  PENDING    = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  DELIVERED  = 'DELIVERED',
}

export enum TransportType {
  COURIER   = 'Courier',
  TRANSPORT = 'Transport',
  BUS       = 'Bus',
  TRAIN     = 'Train',
  AIR       = 'Air',
}

@Entity('dispatches')
export class Dispatch {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  order_id: number;

  @Column({ type: 'varchar', length: 20, default: DispatchStatus.PENDING })
  dispatch_status: DispatchStatus;

  @Column({ type: 'timestamptz', nullable: true })
  dispatch_date: Date;

  @Column({ type: 'timestamptz', nullable: true })
  delivery_date: Date;

  @Column({ type: 'varchar', length: 20, nullable: true })
  transport_type: TransportType;

  @Column({ nullable: true })
  tracking_number: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn({ nullable: true })
  updated_at: Date;
}

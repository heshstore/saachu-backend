import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { DispatchOrderItem } from './dispatch-order-item.entity';

/** Header for operational dispatch — stock OUT only on confirm via inventory_transactions */
export type DispatchOrderHeaderStatus =
  | 'DRAFT'
  | 'READY'
  | 'PARTIAL_DISPATCHED'
  | 'DISPATCHED'
  | 'PARTIAL_DELIVERED'
  | 'DELIVERED'
  | 'CANCELLED';

@Entity('dispatch_orders')
export class DispatchOrder {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ name: 'dispatch_number', length: 40 })
  dispatchNumber: string;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ name: 'customer_id', type: 'int', nullable: true })
  customerId: number | null;

  @Column({ name: 'dispatch_date', type: 'timestamptz', nullable: true })
  dispatchDate: Date | null;

  @Column({ type: 'varchar', length: 30, default: 'DRAFT' })
  status: DispatchOrderHeaderStatus;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'packed_by', type: 'int', nullable: true })
  packedBy: number | null;

  @Column({ name: 'packed_at', type: 'timestamptz', nullable: true })
  packedAt: Date | null;

  @Column({ name: 'dispatched_by', type: 'int', nullable: true })
  dispatchedBy: number | null;

  @Column({ name: 'transporter_name', length: 255, nullable: true })
  transporterName: string | null;

  @Column({ name: 'lr_number', length: 120, nullable: true })
  lrNumber: string | null;

  @Column({ name: 'tracking_number', length: 120, nullable: true })
  trackingNumber: string | null;

  @Column({ name: 'in_transit_at', type: 'timestamptz', nullable: true })
  inTransitAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  /** Operational dispatch costs (not freight accounting) */
  @Column({ name: 'packing_cost', type: 'float', default: 0 })
  packingCost: number;

  @Column({ name: 'logistics_cost', type: 'float', default: 0 })
  logisticsCost: number;

  @Column({ name: 'misc_cost', type: 'float', default: 0 })
  miscCost: number;

  @OneToMany(() => DispatchOrderItem, (l) => l.dispatchOrder, { cascade: true })
  lines: DispatchOrderItem[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

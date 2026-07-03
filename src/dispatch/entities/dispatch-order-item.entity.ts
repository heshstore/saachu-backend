import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DispatchOrder } from './dispatch-order.entity';

@Entity('dispatch_order_items')
export class DispatchOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'dispatch_order_id' })
  dispatchOrderId: number;

  @ManyToOne(() => DispatchOrder, (d) => d.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dispatch_order_id' })
  dispatchOrder: DispatchOrder;

  @Column({ name: 'order_item_id' })
  orderItemId: number;

  /** service_items.id (or catalog id) used for inventory_transactions.item_id */
  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'ordered_qty', type: 'float' })
  orderedQty: number;

  @Column({ name: 'dispatched_qty', type: 'float', default: 0 })
  dispatchedQty: number;

  @Column({ name: 'pending_qty', type: 'float', default: 0 })
  pendingQty: number;

  @Column({ name: 'packed_qty', type: 'float', default: 0 })
  packedQty: number;

  @Column({ name: 'delivered_qty', type: 'float', default: 0 })
  deliveredQty: number;

  @Column({ name: 'packing_remarks', type: 'text', nullable: true })
  packingRemarks: string | null;

  @Column({ name: 'carton_count', type: 'int', nullable: true })
  cartonCount: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

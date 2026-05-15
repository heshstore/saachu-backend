import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { PurchaseOrder } from './purchase-order.entity';

@Entity('purchase_order_items')
export class PurchaseOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'purchase_order_id' })
  purchaseOrderId: number;

  @ManyToOne(() => PurchaseOrder, (o) => o.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder: PurchaseOrder;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'item_source', length: 20, default: 'SERVICE' })
  itemSource: string;

  @Column({ type: 'float' })
  qty: number;

  @Column({ type: 'float' })
  rate: number;

  @Column({ name: 'gst_percent', type: 'float', default: 0 })
  gstPercent: number;

  /** Line total including GST */
  @Column({ name: 'line_total', type: 'float' })
  lineTotal: number;

  @Column({ name: 'received_qty', type: 'float', default: 0 })
  receivedQty: number;

  @Column({ name: 'linked_pr_ids', type: 'jsonb', nullable: true })
  linkedPrIds: number[] | null;
}

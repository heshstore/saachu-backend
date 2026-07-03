import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Order } from './order.entity';

@Entity('order_item')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  sku: string;

  @Column({ nullable: true })
  item_name: string;

  @Column({ nullable: true })
  hsn_code: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  qty: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  base_rate: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  rate: number;

  @Column({ type: 'varchar', length: 10, default: 'percent', nullable: true })
  discount_type: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discount_value: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  gst_percent: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  gst_amount: number;

  @Column({ type: 'text', nullable: true })
  instruction: string;

  @Column({ nullable: true })
  billing_category: string;

  /** Snapshot of the item master's photo URL at creation time. */
  @Column({ type: 'text', nullable: true })
  image_url: string;

  @Index('idx_order_item_order')
  @Column({ name: 'orderId', nullable: true })
  order_id: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;
}

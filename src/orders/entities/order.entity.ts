import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { OrderItem } from './order-item.entity';

export enum OrderStatus {
  PENDING_APPROVAL    = 'PENDING_APPROVAL',
  APPROVED            = 'APPROVED',
  REJECTED            = 'REJECTED',
  IN_PRODUCTION       = 'IN_PRODUCTION',
  READY_FOR_DISPATCH  = 'READY_FOR_DISPATCH',
  DISPATCHED          = 'DISPATCHED',
  COMPLETED           = 'COMPLETED',
  CANCELLED           = 'CANCELLED',
}

@Index('idx_order_customer',    ['customer_id'])
@Index('idx_order_status',      ['status'])
@Index('idx_order_status_id',   ['status', 'id'])   // covers: WHERE status=? ORDER BY id DESC LIMIT n
@Index('idx_order_created_at',  ['created_at'])     // covers: date-range filters in findAll
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true, unique: true })
  order_no: string;

  @Column({ nullable: true })
  quotation_id: number;

  @Column({ nullable: true })
  customer_id: number;

  @Column({ nullable: true })
  lead_id: number;

  // ── Customer snapshot — frozen at creation ──────────────────────────────────
  @Column({ nullable: true })
  customer_name: string;

  @Column({ nullable: true })
  customer_phone: string;

  @Column({ type: 'text', nullable: true })
  billing_address: string;

  @Column({ type: 'text', nullable: true })
  shipping_address: string;

  @Column({ nullable: true })
  gst_number: string;

  // ── Totals ──────────────────────────────────────────────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  subtotal: number;

  @Column({ type: 'varchar', length: 10, default: 'PERCENT', nullable: true })
  discount_type: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discount_value: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  packing_charges: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  cartage_charges: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  forwarding_charges: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  installation_charges: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  loading_charges: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_amount: number;

  // ── Status ──────────────────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 25, default: OrderStatus.PENDING_APPROVAL })
  status: OrderStatus;

  // ── Approval ────────────────────────────────────────────────────────────────
  @Column({ type: 'text', nullable: true })
  approval_remarks: string;

  @Column({ name: 'approved_by_id', nullable: true })
  approved_by: number;

  @Column({ type: 'timestamp', nullable: true })
  approved_at: Date;

  // ── Payment tracking — kept for PaymentService sync ─────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  paid_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  pending_amount: number;

  // ── Misc ────────────────────────────────────────────────────────────────────
  @Column({ nullable: true })
  salesman_id: number;

  @Column({ nullable: true })
  created_by: number;

  @Index('idx_order_idempotency_key')
  @Column({ nullable: true })
  idempotency_key: string;

  @Column({ type: 'timestamptz', nullable: true })
  due_date: Date;

  @Column({ type: 'timestamptz', nullable: true })
  idempotency_created_at: Date;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn({ nullable: true })
  updated_at: Date;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true, eager: true })
  items: OrderItem[];
}

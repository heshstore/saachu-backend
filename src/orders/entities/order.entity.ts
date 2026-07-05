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
  DRAFT = 'DRAFT',
  GENERATED = 'GENERATED',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  IN_PRODUCTION = 'IN_PRODUCTION',
  READY = 'READY',
  // Keep for backward compatibility with existing DB rows written before the rename
  READY_FOR_DISPATCH = 'READY_FOR_DISPATCH',
  PARTIAL_DISPATCHED = 'PARTIAL_DISPATCHED',
  DISPATCHED = 'DISPATCHED',
  PARTIAL_DELIVERED = 'PARTIAL_DELIVERED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

@Index('idx_order_customer', ['customer_id'])
@Index('idx_order_status', ['status'])
@Index('idx_order_status_id', ['status', 'id']) // covers: WHERE status=? ORDER BY id DESC LIMIT n
@Index('idx_order_created_at', ['created_at']) // covers: date-range filters in findAll
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

  // Extra Tax (false, default): item rate is pre-tax, GST added on top.
  // Inclusive Tax (true): item rate already includes GST, extracted at calc time.
  @Column({ type: 'boolean', default: false })
  is_tax_inclusive: boolean;

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
  @Column({ type: 'varchar', length: 30, default: OrderStatus.DRAFT })
  status: OrderStatus;

  // ── Approval — salesperson data (set when sending for approval) ─────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  advance_amount: number;

  @Column({ default: false, nullable: true })
  process_without_advance: boolean;

  @Column({ type: 'text', nullable: true })
  approval_remarks: string; // salesperson's text notes — NOT overwritten on reject/approve

  // ── Approval — manager data ────────────────────────────────────────────────
  @Column({ name: 'approved_by_id', nullable: true })
  approved_by: number;

  @Column({ type: 'timestamp', nullable: true })
  approved_at: Date;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string; // manager's rejection feedback — separate from approval_remarks

  // ── Payment tracking — kept for PaymentService sync ─────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  paid_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  pending_amount: number;

  // ── Dispatch / Delivery ─────────────────────────────────────────────────────
  @Column({ nullable: true })
  booking_at: string;

  @Column({ nullable: true })
  goods_sent_by: string;

  @Column({ nullable: true })
  transport_payment_by: string;

  @Column({ type: 'text', nullable: true })
  delivery_instructions: string;

  @Column({ nullable: true })
  delivery_type: string;

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

  @OneToMany(() => OrderItem, (item) => item.order, {
    cascade: true,
    eager: true,
  })
  items: OrderItem[];
}

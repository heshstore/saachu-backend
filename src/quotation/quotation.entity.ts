import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { QuotationItem } from './quotation-item.entity';

export enum QuotationStatus {
  DRAFT     = 'DRAFT',
  SENT      = 'SENT',
  APPROVED  = 'APPROVED',
  REJECTED  = 'REJECTED',
  CANCELLED = 'CANCELLED',
  CONVERTED = 'CONVERTED', // quotation → order
}

export enum QuotationDiscountType {
  PERCENT = 'PERCENT',
  FLAT    = 'FLAT',
}

@Index('idx_quotation_customer', ['customer_id'])
@Index('idx_quotation_salesman', ['salesman_id'])
@Index('idx_quotation_status',   ['status'])
@Entity('quotation')
export class Quotation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true, unique: true })
  quotation_no: string;

  @Column({ nullable: true })
  lead_id: number;

  @Column({ nullable: true })
  customer_id: number;

  // ── Customer snapshot — frozen at creation, never read from live customer table ─
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

  @Column({ nullable: true })
  bill_to_id: number;

  @Column({ nullable: true })
  ship_to_id: number;

  @Column({ nullable: true })
  salesman_id: number;

  @Column({ type: 'varchar', length: 20, default: QuotationStatus.DRAFT })
  status: QuotationStatus;

  @Column({ default: 15 })
  validity_days: number;

  @Column({ type: 'date', nullable: true })
  valid_till: Date;

  @Column({ nullable: true })
  delivery_by: string;

  @Column({ nullable: true })
  delivery_type: string;

  @Column({ nullable: true })
  payment_type: string;

  @Column({ type: 'text', nullable: true })
  delivery_instructions: string;

  // ── Header-level discount ────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 10, default: QuotationDiscountType.PERCENT, nullable: true })
  discount_type: QuotationDiscountType;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discount_value: number;

  // ── Additional charges ───────────────────────────────────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  charges_packing: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  charges_cartage: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  charges_forwarding: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  charges_installation: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  charges_loading: number;

  // ── Totals ───────────────────────────────────────────────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  sub_total: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_amount: number;

  // ── Audit ────────────────────────────────────────────────────────────────────
  @Column({ nullable: true })
  cancelled_by: number;

  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date;

  @Column({ nullable: true })
  created_by: number;

  @Column({ default: false })
  is_wholesaler: boolean;

  @Column({ default: 1 })
  version: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn({ nullable: true })
  updated_at: Date;

  @DeleteDateColumn({ nullable: true })
  deleted_at: Date;

  @OneToMany(() => QuotationItem, (item) => item.quotation, {
    cascade: true,
    eager: true,
  })
  items: QuotationItem[];
}

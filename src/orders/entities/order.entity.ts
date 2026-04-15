import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { OrderItem } from './order-item.entity';
import { Customer } from '../../customers/entities/customer.entity';

// 🚀 STRICT MODE PATCH
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Customer, { eager: true })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column()
  customer_name: string;

  @Column()
  mobile: string;

  // 💰 AMOUNTS (ALL DECIMAL - ACCOUNTING SAFE)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  paid_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  pending_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  gst_bill_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  non_gst_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  taxable_amount: number;

  // 📊 PERCENTAGES
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  gst_percentage: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 100 })
  gst_split_percent: number;

  // 📅 CREDIT
  @Column({ default: 0 })
  credit_days: number;

  @Column({ type: 'timestamp', nullable: true })
  due_date: Date;

  // 👨‍💼 SALES
  @Column({ default: false })
  commission_eligible: boolean;

  @Column({ default: 1 })
  salesman_id: number;

  // ✅ APPROVAL
  @Column({ nullable: true })
  approved_by: string;

  @Column({ type: 'timestamp', nullable: true })
  approved_at: Date;

  // 📄 STATUS

  @Column({ type: 'date', nullable: true })
  quotation_date: Date;

  @Column({ type: 'date', nullable: true })
  valid_till: Date;

  // 📦 ITEMS
  @OneToMany(() => OrderItem, (item) => item.order, {
    cascade: true,
    eager: true,
  })
  items: OrderItem[];

  @Column({ unique: true })
  order_number: string;

  @Column({ type: 'timestamp', nullable: true })
  order_date: Date;

  // 🚀 STRICT MODE PATCH: This is the main status field, default='Draft'
  @Column({ default: 'Draft' })
  status: string;

  @Column({ type: 'varchar', nullable: true })
  department: string;

  @Column({ nullable: true })
  quotation_id: number;

  @Column({ default: 'Draft' })
  draft_status: string;

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

  @Column({ nullable: true })
  rejection_reason: string;

  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date;

  @Column({ nullable: true })
  cancelled_by: string;
}
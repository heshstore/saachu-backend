import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Order } from './order.entity';

export type PaymentMode = 'cash' | 'upi' | 'bank';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Index('idx_payment_order')
  @Column()
  order_id: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ default: 'cash' })
  payment_mode: PaymentMode;

  @Column({ nullable: true, unique: true })
  payment_reference: string;

  @Column({ nullable: true, unique: true })
  idempotency_key: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ nullable: true })
  created_by: number;

  @CreateDateColumn()
  created_at: Date;
}

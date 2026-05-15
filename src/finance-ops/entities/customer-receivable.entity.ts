import {
  Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Index,
} from 'typeorm';

export type ReceivableStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

@Entity('customer_receivables')
@Index('idx_customer_receivables_customer', ['customerId'])
@Index('idx_customer_receivables_status', ['status'])
export class CustomerReceivable {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'customer_id' })
  customerId: number;

  @Column({ name: 'order_id', unique: true })
  orderId: number;

  @Column({ name: 'total_order_value', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalOrderValue: string;

  @Column({ name: 'received_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  receivedAmount: string;

  @Column({ name: 'outstanding_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  outstandingAmount: string;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: ReceivableStatus;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

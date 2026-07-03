import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type FinancePaymentType = 'CUSTOMER_RECEIPT' | 'VENDOR_PAYMENT';
export type FinancePaymentMode = 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER';

@Entity('payment_entries')
@Index('idx_payment_entries_type_date', ['paymentType', 'paymentDate'])
export class PaymentEntry {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'payment_type', length: 30 })
  paymentType: FinancePaymentType;

  @Column({ name: 'reference_type', length: 30, nullable: true })
  referenceType: string | null;

  @Column({ name: 'reference_id', type: 'int', nullable: true })
  referenceId: number | null;

  @Column({ name: 'customer_id', type: 'int', nullable: true })
  customerId: number | null;

  @Column({ name: 'vendor_id', type: 'int', nullable: true })
  vendorId: number | null;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount: string;

  @Column({ name: 'payment_mode', length: 20 })
  paymentMode: FinancePaymentMode;

  @Column({ name: 'payment_date', type: 'date' })
  paymentDate: string;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  /** When this row mirrors a row in `payments` (order receipt). */
  @Column({
    name: 'linked_payment_id',
    type: 'int',
    nullable: true,
    unique: true,
  })
  linkedPaymentId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Internal split allocation — never visible in customer-facing ledger
  @Column({
    name: 'production_amount',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  productionAmount: string | null;

  @Column({ name: 'production_bank', nullable: true })
  productionBank: string | null;

  @Column({
    name: 'trading_amount',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  tradingAmount: string | null;

  @Column({ name: 'trading_bank', nullable: true })
  tradingBank: string | null;
}

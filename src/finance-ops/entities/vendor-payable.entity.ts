import {
  Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Index,
} from 'typeorm';

export type PayableStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

@Entity('vendor_payables')
@Index('idx_vendor_payables_vendor', ['vendorId'])
@Index('idx_vendor_payables_status', ['status'])
export class VendorPayable {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'vendor_id' })
  vendorId: number;

  @Column({ name: 'purchase_order_id', unique: true })
  purchaseOrderId: number;

  @Column({ name: 'total_po_value', type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalPoValue: string;

  @Column({ name: 'paid_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  paidAmount: string;

  @Column({ name: 'outstanding_amount', type: 'decimal', precision: 14, scale: 2, default: 0 })
  outstandingAmount: string;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: PayableStatus;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

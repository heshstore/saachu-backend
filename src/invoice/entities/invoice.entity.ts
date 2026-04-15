import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  order_id: number;

  @Column({ nullable: true, unique: true })
  invoice_no: string;

  @Column({ default: 'TALLY' })
  type: string;

  @Column('decimal')
  total_amount: number;

  @Column({ default: 'saachu' })
  invoice_type: string;

  @Column({ default: 'pending' })
  status: string;

  @Column({ default: 'none' })
  gst_type: string;

  @Column({ nullable: true })
  tally_invoice_no: string;

  @Column({ type: 'date', nullable: true })
  tally_date: Date;

  @Column('decimal', { nullable: true })
  tally_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  cgst: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  sgst: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  igst: number;

  @CreateDateColumn()
  created_at: Date;
}
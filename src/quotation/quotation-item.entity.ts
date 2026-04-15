import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Quotation } from './quotation.entity';

@Entity('quotation_item')
export class QuotationItem {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Quotation, (q) => q.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'quotation_id' })
  quotation: Quotation;

  @Column({ nullable: true })
  sku: string;

  @Column({ nullable: true })
  item_name: string;

  @Column({ type: 'text', nullable: true })
  instruction: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  qty: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  rate: number;

  @Column({ default: 'percent' })
  discount_type: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discount_value: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  gst_percent: number;

  @Column({ nullable: true })
  hsn_code: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  amount: number;
}

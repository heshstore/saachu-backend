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

  /** Explicit FK column — readable without loading the relation. */
  @Column({ nullable: true })
  quotation_id: number;

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

  /** Price from item master at the time of quotation — rate cannot go below this. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  base_rate: number;

  /** Actual rate offered — must be >= base_rate. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  rate: number;

  @Column({ default: 'percent' })
  discount_type: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discount_value: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  gst_percent: number;

  /** Per-item override: true = rate already includes GST (extracted at calc time). */
  @Column({ default: false })
  is_tax_inclusive: boolean;

  @Column({ nullable: true })
  hsn_code: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  amount: number;

  @Column({ nullable: true })
  billing_category: string;

  /** Snapshot of the item master's photo URL at creation time. */
  @Column({ type: 'text', nullable: true })
  image_url: string;

  /** Unit of measure — snapshot from the service-item/Shopify catalog master at creation time. */
  @Column({ type: 'text', nullable: true })
  unit: string;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { QuotationItem } from './quotation-item.entity';

@Entity('quotation')
export class Quotation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true, unique: true })
  quotation_no: string;

  @Column({ nullable: true })
  customer_id: number;

  @Column({ nullable: true })
  customer_name: string;

  @Column({ nullable: true })
  bill_to_id: number;

  @Column({ nullable: true })
  ship_to_id: number;

  @Column({ nullable: true })
  salesman_id: number;

  @Column({ default: 'OPEN' })
  status: string;

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

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  sub_total: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_amount: number;

  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date;

  @Column({ nullable: true })
  cancelled_by: number;

  @Column({ nullable: true })
  created_by: number;

  @Column({ default: false })
  is_wholesaler: boolean;

  @CreateDateColumn()
  created_at: Date;

  @Column({ default: 1 })
  version: number;

  @OneToMany(() => QuotationItem, (item) => item.quotation, {
    cascade: true,
    eager: true,
  })
  items: QuotationItem[];
}

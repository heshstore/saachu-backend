import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  order_id: number;

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
}
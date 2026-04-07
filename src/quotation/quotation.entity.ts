import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Quotation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  customer_name: string;

  @Column({ default: 'OPEN' })
  status: string;

  @Column({ type: 'json', nullable: true })
  items: any;

  @Column({ nullable: true })
  total_amount: number;
}
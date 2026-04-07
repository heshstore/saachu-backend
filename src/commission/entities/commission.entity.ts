import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Commission {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  order_id: number;

  @Column()
  salesman_id: number;

  @Column()
  amount: number;

  @Column()
  commission_rate: number;

  @Column()
  commission_amount: number;

  @Column({ default: false })
  is_paid: boolean;

  @Column()
  month: string;
}
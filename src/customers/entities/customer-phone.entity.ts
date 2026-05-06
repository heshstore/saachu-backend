import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('customer_phones')
export class CustomerPhone {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  customer_id: number;

  @Column({ unique: true })
  @Index()
  phone: string;
}

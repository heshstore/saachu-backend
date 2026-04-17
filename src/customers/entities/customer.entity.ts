import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique } from 'typeorm';

@Entity()
@Unique('UQ_customer_name_tag_city', ['companyName', 'tag', 'city'])
export class Customer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  companyName: string;

  @Column()
  contactName: string;

  @Column({ unique: true })
  mobile1: string;

  @Column({ nullable: true })
  mobile2: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  address: string;

  @Column()
  city: string;

  @Column()
  state: string;

  @Column()
  pincode: string;

  @Column({ unique: true, nullable: true })
  gstNumber: string;

  @Column({ default: 'Retail Shop' })
  customerType: string;

  @Column({ nullable: true })
  tag: string;

  @Column({ type: 'decimal', default: 0 })
  creditLimit: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ default: "India" })
  country: string;

  @Column({ default: '+91' })
  country_code: string;

  @Column({ type: 'smallint', default: 0 })
  credit_days: number;

  @Column({ default: false })
  isWholesaler: boolean;
}
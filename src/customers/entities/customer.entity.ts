import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Customer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  companyName: string;

  @Column()
  contactName: string;

  @Column()
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

  @Column({ nullable: true })
  gstNumber: string;

  @Column({ default: 'regular' })
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
}
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('vendors')
export class Vendor {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'vendor_code', length: 40, unique: true })
  vendorCode: string;

  @Column({ name: 'vendor_name' })
  vendorName: string;

  @Column({ name: 'contact_person', length: 200, nullable: true })
  contactPerson: string | null;

  @Column({ length: 40, nullable: true })
  phone: string | null;

  @Column({ length: 200, nullable: true })
  email: string | null;

  @Column({ name: 'gst_number', length: 32, nullable: true })
  gstNumber: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ length: 120, nullable: true })
  city: string | null;

  @Column({ length: 120, nullable: true })
  state: string | null;

  @Column({ length: 20, nullable: true })
  pincode: string | null;

  @Column({ name: 'payment_terms', length: 255, nullable: true })
  paymentTerms: string | null;

  @Column({ default: true })
  active: boolean;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

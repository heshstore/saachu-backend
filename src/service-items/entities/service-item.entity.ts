import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('service_items')
export class ServiceItem {
  @PrimaryGeneratedColumn()
  id: number;

  /** SVC-000001 format — auto-generated on creation */
  @Column({ name: 'item_code', unique: true })
  itemCode: string;

  @Column({ name: 'item_name', nullable: true })
  itemName: string;

  @Column({ nullable: true, unique: true })
  sku: string;

  @Column({ name: 'hsn_code', default: '' })
  hsnCode: string;

  @Column({ type: 'float', default: 0 })
  gst: number;

  @Column({ name: 'cost_price', type: 'float', default: 0 })
  costPrice: number;

  @Column({ name: 'selling_price', type: 'float', default: 0 })
  sellingPrice: number;

  @Column({ default: 'Nos' })
  unit: string;

  @Column({ default: 'MANUAL' })
  source: string;

  /** Soft delete — false = hidden from all lists */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

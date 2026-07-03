import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  // ── Item Classification Fields ──────────────────────────────────────────────

  /** TRADING | MANUFACTURING | SERVICE */
  @Column({ name: 'main_category_type', default: 'TRADING' })
  mainCategoryType: string;

  /** Applies when mainCategoryType = SERVICE: AMC | REPAIR | COMPLAINT | SPARE_PART */
  @Column({ name: 'service_subtype', nullable: true })
  serviceSubtype: string | null;

  /** NOT_CREATED | PARTIAL | COMPLETE */
  @Column({ name: 'boq_status', default: 'NOT_CREATED' })
  boqStatus: string;

  @Column({ name: 'requires_production', default: false })
  requiresProduction: boolean;

  @Column({ name: 'requires_purchase', default: true })
  requiresPurchase: boolean;

  /** PCS | SQFT | KG | METER | SHEET */
  @Column({ name: 'stock_tracking_type', default: 'PCS' })
  stockTrackingType: string;

  @Column({ name: 'is_raw_material', default: false })
  isRawMaterial: boolean;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

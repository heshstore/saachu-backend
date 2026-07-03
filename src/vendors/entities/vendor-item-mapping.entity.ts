import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Vendor } from './vendor.entity';

/** SERVICE = service_items.id; SHOPIFY = shopify_catalog_items.id */
@Entity('vendor_item_mappings')
@Index(['itemId', 'itemSource'])
export class VendorItemMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'vendor_id' })
  vendorId: number;

  @ManyToOne(() => Vendor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vendor_id' })
  vendor: Vendor;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'item_source', length: 20, default: 'SERVICE' })
  itemSource: string;

  @Column({ name: 'vendor_sku', length: 120, nullable: true })
  vendorSku: string | null;

  @Column({ name: 'purchase_rate', type: 'float', default: 0 })
  purchaseRate: number;

  @Column({ name: 'minimum_order_qty', type: 'float', default: 0 })
  minimumOrderQty: number;

  @Column({ name: 'lead_time_days', default: 0 })
  leadTimeDays: number;

  @Column({ name: 'preferred_vendor', default: false })
  preferredVendor: boolean;

  @Column({ name: 'last_purchase_rate', type: 'float', nullable: true })
  lastPurchaseRate: number | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

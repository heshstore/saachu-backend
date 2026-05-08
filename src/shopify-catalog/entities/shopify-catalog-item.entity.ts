import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('shopify_catalog_items')
export class ShopifyCatalogItem {
  @PrimaryGeneratedColumn()
  id: number;

  /** SP_<productId>_<variantId> — internal catalog code */
  @Column({ name: 'item_code', unique: true })
  itemCode: string;

  @Column({ name: 'shopify_product_id', nullable: true })
  shopifyProductId: string;

  /** Stable Shopify identifier — used as upsert key during sync */
  @Column({ name: 'shopify_variant_id', unique: true })
  shopifyVariantId: string;

  @Column({ name: 'item_name', nullable: true })
  itemName: string;

  @Column({ nullable: true, unique: true })
  sku: string;

  @Column({ name: 'selling_price', type: 'float', default: 0 })
  sellingPrice: number;

  @Column({ name: 'retail_price', type: 'float', default: 0 })
  retailPrice: number;

  @Column({ name: 'wholesale_price', type: 'float', default: 0 })
  wholesalePrice: number;

  @Column({ nullable: true })
  image: string;

  @Column({ default: 'Nos' })
  unit: string;

  /** Filled by operations team before item is usable in quotations/orders */
  @Column({ name: 'hsn_code', default: '' })
  hsnCode: string;

  @Column({ type: 'float', default: 0 })
  gst: number;

  @Column({ name: 'cost_price', type: 'float', default: 0 })
  costPrice: number;

  /** Soft-delete: true = skip on next sync, excluded from all searches */
  @Column({ name: 'sync_ignored', default: false })
  syncIgnored: boolean;

  @Column({ default: 'SHOPIFY' })
  source: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

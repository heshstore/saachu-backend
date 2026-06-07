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

  /** Stable Shopify identifier — primary upsert key during sync */
  @Column({ name: 'shopify_variant_id', unique: true })
  shopifyVariantId: string;

  /** Shopify inventory_item_id — needed for future inventory-level sync */
  @Column({ name: 'shopify_inventory_item_id', nullable: true })
  shopifyInventoryItemId: string;

  /** Shopify product handle (e.g. "wire-panel-2x4") — used to build the product page URL.
   *  Populated by Shopify sync. Null until sync runs. */
  @Column({ nullable: true, default: null })
  handle: string | null;

  /** Shopify's own updated_at for this variant — used to validate incremental sync */
  @Column({ name: 'shopify_updated_at', type: 'timestamptz', nullable: true })
  shopifyUpdatedAt: Date;

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

  // ── ERP classification — set manually after sync, never during sync ──────────

  /** TRADING | MANUFACTURING | SERVICE — null until manually assigned */
  @Column({ name: 'main_category_type', nullable: true, default: null })
  mainCategoryType: string | null;

  /** Applies when mainCategoryType = SERVICE: AMC | REPAIR | COMPLAINT | SPARE_PART */
  @Column({ name: 'service_subtype', nullable: true, default: null })
  serviceSubtype: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Item {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  itemName: string;

  @Column({ unique: true })
  sku: string;

  @Column({ type: 'float', default: 0 })
  gst: number;

  @Column({ type: 'float', default: 0 })
  costPrice: number;

  @Column({ type: 'float', default: 0 })
  sellingPrice: number;

  @Column({ nullable: true })
  hsnCode: string;

  @Column({ nullable: true })
  source: string;

  /** Shopify variant numeric ID — used as the stable match key during sync */
  @Column({ nullable: true })
  shopifyVariantId: string;

  @Column({ default: "Nos" })
  unit: string;

  @Column({ nullable: true })
  image: string;

  @Column({ type: 'float', default: 0 })
  retail_price: number;

  @Column({ type: 'float', default: 0 })
  wholesale_price: number;
}
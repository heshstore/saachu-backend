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
}
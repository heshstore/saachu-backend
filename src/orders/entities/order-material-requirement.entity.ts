import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('order_material_requirements')
export class OrderMaterialRequirement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'order_id' })
  orderId: number;

  @Column({ name: 'order_item_id' })
  orderItemId: number;

  /** service_items.id of the finished manufactured item */
  @Column({ name: 'item_id' })
  itemId: number;

  /** service_items.id of the raw material */
  @Column({ name: 'raw_material_item_id' })
  rawMaterialItemId: number;

  @Column({ name: 'boq_item_id', nullable: true })
  boqItemId: number | null;

  /** qtyPerUnit × orderedQty */
  @Column({ name: 'required_qty', type: 'float' })
  requiredQty: number;

  @Column({ name: 'consumption_type', length: 20 })
  consumptionType: string;

  @Column({ name: 'wastage_percent', type: 'float', default: 0 })
  wastagePercent: number;

  /** requiredQty × (1 + wastagePercent / 100) */
  @Column({ name: 'calculated_qty', type: 'float' })
  calculatedQty: number;

  /** PENDING | READY | SHORTAGE */
  @Column({ length: 20, default: 'PENDING' })
  status: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

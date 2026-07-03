import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('purchase_requirements')
export class PurchaseRequirement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'item_id' })
  itemId: number;

  // Null = aggregate across all warehouses; set when warehouse-specific planning is needed
  @Column({ name: 'warehouse_id', type: 'int', nullable: true })
  warehouseId: number | null;

  // ORDER | MANUAL
  @Column({ name: 'source_type', default: 'ORDER' })
  sourceType: string;

  // orderId when sourceType = 'ORDER'
  @Column({ name: 'source_id', type: 'int', nullable: true })
  sourceId: number | null;

  @Column({ name: 'required_qty', type: 'float' })
  requiredQty: number;

  @Column({ name: 'available_qty', type: 'float', default: 0 })
  availableQty: number;

  @Column({ name: 'shortage_qty', type: 'float' })
  shortageQty: number;

  @Column({ default: 'PCS' })
  unit: string;

  // PENDING | APPROVED | ORDERED | CANCELLED
  @Column({ default: 'PENDING' })
  status: string;

  // LOW | MEDIUM | HIGH | URGENT
  @Column({ default: 'MEDIUM' })
  priority: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'purchase_order_id', type: 'int', nullable: true })
  purchaseOrderId: number | null;

  @Column({ name: 'po_number', length: 40, nullable: true })
  poNumber: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

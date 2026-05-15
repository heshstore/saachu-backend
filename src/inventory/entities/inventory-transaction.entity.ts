import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('inventory_transactions')
export class InventoryTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'warehouse_id' })
  warehouseId: number;

  // OPENING_STOCK | PURCHASE_RECEIPT | SALES_DISPATCH | MATERIAL_ISSUE |
  // PRODUCTION_RECEIPT | SCRAP | MANUAL_ADJUSTMENT | PRODUCTION_CONSUMPTION |
  // FG_PRODUCTION_IN | SERVICE_SPARE_USE (after-sales spare issue)
  @Column({ name: 'transaction_type' })
  transactionType: string;

  // IN | OUT | ADJUSTMENT
  @Column()
  direction: string;

  @Column({ type: 'float' })
  qty: number;

  // PCS | SQFT | SHEET | KG | METER | LITER
  @Column({ default: 'PCS' })
  unit: string;

  // Cost per unit at time of transaction (optional)
  @Column({ name: 'rate', type: 'float', nullable: true })
  rate: number | null;

  // e.g. 'ORDER', 'PURCHASE', 'MANUAL'
  @Column({ name: 'reference_type', nullable: true })
  referenceType: string | null;

  @Column({ name: 'reference_id', type: 'int', nullable: true })
  referenceId: number | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

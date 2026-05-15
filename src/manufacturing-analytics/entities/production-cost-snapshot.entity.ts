import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

/** Immutable cost freeze when a production execution job completes */
@Entity('production_cost_snapshots')
export class ProductionCostSnapshot {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'order_id' })
  orderId: number;

  @Index({ unique: true })
  @Column({ name: 'production_job_id' })
  productionJobId: number;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'raw_material_cost', type: 'double precision', default: 0 })
  rawMaterialCost: number;

  @Column({ name: 'production_cost', type: 'double precision', default: 0 })
  productionCost: number;

  @Column({ name: 'wastage_cost', type: 'double precision', default: 0 })
  wastageCost: number;

  @Column({ name: 'dispatch_cost', type: 'double precision', default: 0 })
  dispatchCost: number;

  @Column({ name: 'total_cost', type: 'double precision', default: 0 })
  totalCost: number;

  @Column({ name: 'cost_per_unit', type: 'double precision', default: 0 })
  costPerUnit: number;

  @Column({ name: 'produced_qty', type: 'double precision', default: 0 })
  producedQty: number;

  @Column({ name: 'rejected_qty', type: 'double precision', default: 0 })
  rejectedQty: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

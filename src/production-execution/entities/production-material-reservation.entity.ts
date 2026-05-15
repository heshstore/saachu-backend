import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('production_material_reservations')
export class ProductionMaterialReservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'production_job_id' })
  productionJobId: number;

  @Column({ name: 'production_stage_id', type: 'int', nullable: true })
  productionStageId: number | null;

  @Column({ name: 'raw_material_item_id' })
  rawMaterialItemId: number;

  @Column({ name: 'required_qty', type: 'float' })
  requiredQty: number;

  @Column({ name: 'reserved_qty', type: 'float', default: 0 })
  reservedQty: number;

  @Column({ name: 'consumed_qty', type: 'float', default: 0 })
  consumedQty: number;

  @Column({ name: 'warehouse_id' })
  warehouseId: number;

  /** RESERVED | PARTIAL | CONSUMED | CANCELLED */
  @Column({ length: 20, default: 'RESERVED' })
  status: string;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'planned_rate', type: 'float', nullable: true })
  plannedRate: number | null;

  @Column({ name: 'actual_rate', type: 'float', nullable: true })
  actualRate: number | null;

  @Column({ name: 'consumed_value', type: 'float', nullable: true })
  consumedValue: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

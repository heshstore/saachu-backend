import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ManufacturingBoq } from './manufacturing-boq.entity';

@Entity('manufacturing_boq_items')
export class ManufacturingBoqItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'boq_id' })
  boqId: number;

  @ManyToOne(() => ManufacturingBoq, (boq) => boq.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'boq_id' })
  boq: ManufacturingBoq;

  @Column({ name: 'raw_material_item_id' })
  rawMaterialItemId: number;

  @Column({ name: 'department_id' })
  departmentId: number;

  @Column({ name: 'consumption_type', length: 20 })
  consumptionType: string;

  @Column({ name: 'qty_per_unit', type: 'float' })
  qtyPerUnit: number;

  @Column({ name: 'wastage_percent', type: 'float', default: 0 })
  wastagePercent: number;

  @Column({ type: 'float', nullable: true })
  width: number | null;

  @Column({ type: 'float', nullable: true })
  height: number | null;

  @Column({ name: 'sheet_size', length: 50, nullable: true })
  sheetSize: string | null;

  @Column({ name: 'formula_type', length: 30, nullable: true })
  formulaType: string | null;

  @Column({ name: 'preferred_vendor', nullable: true })
  preferredVendor: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'text', nullable: true })
  image: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

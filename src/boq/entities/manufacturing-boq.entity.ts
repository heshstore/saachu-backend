import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { ManufacturingBoqItem } from './manufacturing-boq-item.entity';

@Entity('manufacturing_boqs')
export class ManufacturingBoq {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ default: 1 })
  version: number;

  @Column({ default: 'DRAFT', length: 20 })
  status: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by', nullable: true })
  createdBy: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ManufacturingBoqItem, (line) => line.boq, {
    eager: true,
    cascade: true,
  })
  lines: ManufacturingBoqItem[];
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('departments')
export class Department {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  code: string;

  @Column({ name: 'daily_capacity', type: 'float', nullable: true })
  dailyCapacity: number | null;

  @Column({ name: 'capacity_unit', nullable: true })
  capacityUnit: string | null;

  @Column({ name: 'manpower_capacity', type: 'int', nullable: true })
  manpowerCapacity: number | null;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

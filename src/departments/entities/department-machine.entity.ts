import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type MachineStatus = 'RUNNING' | 'IDLE' | 'BREAKDOWN' | 'MAINTENANCE';

@Entity('department_machines')
export class DepartmentMachine {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ name: 'machine_ref_id', nullable: true }) machineRefId: string | null;
  @Column() name: string;
  @Column({ name: 'machine_type', nullable: true }) machineType: string | null;
  @Column({ nullable: true }) model: string | null;
  @Column({ name: 'serial_number', nullable: true }) serialNumber: string | null;
  @Column({ name: 'installation_date', type: 'date', nullable: true }) installationDate: string | null;
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true }) capacity: number | null;
  @Column({ name: 'capacity_unit', nullable: true }) capacityUnit: string | null;
  @Column({ default: 'IDLE' }) status: MachineStatus;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

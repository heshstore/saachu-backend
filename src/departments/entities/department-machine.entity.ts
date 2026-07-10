import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

// Operational state only — what the machine is physically doing.
// Inspection readiness is a separate concern tracked via lastInspectedAt.
export type MachineOperationalStatus = 'IDLE' | 'RUNNING' | 'BREAKDOWN' | 'MAINTENANCE';

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

  // Operational status — independent of inspection validity
  @Column({ default: 'IDLE' }) status: MachineOperationalStatus;

  // Inspection cache — set by inspectMachine(), never by status changes
  @Column({ name: 'last_inspected_at', type: 'timestamptz', nullable: true }) lastInspectedAt: Date | null;
  @Column({ name: 'last_inspected_by', nullable: true }) lastInspectedBy: number | null;

  // operator nullable — reserved for Phase 2 Operator Assignment module
  @Column({ nullable: true }) operator: string | null;
  // ready_date kept for backward compat — not used in new logic
  @Column({ name: 'ready_date', type: 'date', nullable: true }) readyDate: string | null;

  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

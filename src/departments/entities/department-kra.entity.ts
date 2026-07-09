import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('department_kras')
export class DepartmentKra {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ name: 'kra_name' }) kraName: string;
  @Column({ nullable: true, type: 'text' }) description: string | null;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

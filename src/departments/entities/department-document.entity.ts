import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('department_documents')
export class DepartmentDocument {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'department_id' }) departmentId: number;
  @Column({ name: 'doc_type', default: 'SOP' }) docType: string;
  @Column({ name: 'doc_name' }) docName: string;
  @Column({ name: 'file_url', nullable: true, type: 'text' }) fileUrl: string | null;
  @Column({ name: 'uploaded_by', nullable: true }) uploadedBy: number | null;
  @CreateDateColumn({ name: 'uploaded_at' }) uploadedAt: Date;
}

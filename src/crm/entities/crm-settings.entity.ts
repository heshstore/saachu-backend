import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('crm_settings')
export class CrmSettings {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at: Date;
}

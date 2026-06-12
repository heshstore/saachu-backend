import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('import_skipped_contacts')
export class ImportSkippedContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** G1–G5 code */
  @Column({ type: 'varchar', length: 30 })
  @Index()
  reason_code: string;

  /** Human-readable reason detail */
  @Column({ type: 'text' })
  reason: string;

  /** 1-based row number within the original CSV batch */
  @Column({ type: 'int', nullable: true })
  row_number: number | null;

  @Column({ nullable: true })
  @Index()
  phone: string | null;

  @Column({ nullable: true })
  email: string | null;

  @Column({ nullable: true })
  company: string | null;

  @Column({ nullable: true })
  name: string | null;

  @Column({ nullable: true })
  city: string | null;

  @Column({ nullable: true })
  business_type: string | null;

  /** UUID generated per import call — groups skips from the same batch */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  import_batch_id: string | null;

  /** Full original row from the CSV for recovery pre-fill */
  @Column({ type: 'jsonb', nullable: true })
  raw_row: Record<string, any> | null;

  @Column({ type: 'boolean', default: false })
  recovered: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  recovered_at: Date | null;

  /** Timestamp of the import that produced this skip */
  @CreateDateColumn({ type: 'timestamptz' })
  imported_at: Date;
}

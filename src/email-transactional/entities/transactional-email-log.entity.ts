import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('transactional_email_logs')
@Index('idx_tel_entity', ['entity_type', 'entity_id'])
export class TransactionalEmailLog {
  @PrimaryGeneratedColumn()
  id: number;

  /** 'quotation' | 'order' | 'invoice' */
  @Column({ type: 'varchar', length: 20 })
  entity_type: string;

  @Column({ type: 'int' })
  entity_id: number;

  @Column({ type: 'varchar', length: 255 })
  recipient_email: string;

  @Column({ type: 'varchar', length: 255 })
  subject: string;

  /** 'sent' | 'failed' */
  @Column({ type: 'varchar', length: 10, default: 'sent' })
  status: string;

  /** SMTP provider identifier — 'smtp' for Hotmail/Office365/SMTP */
  @Column({ type: 'varchar', length: 30, default: 'smtp' })
  provider: string;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

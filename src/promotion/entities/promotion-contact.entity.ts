import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('promotion_contacts')
export class PromotionContact {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 15, nullable: true })
  whatsapp_number: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'text', nullable: true })
  source: string;

  @Column({ type: 'text', nullable: true })
  page_url: string;

  @Column({ type: 'text', nullable: true, default: 'promotion_capture' })
  tag: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}

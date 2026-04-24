import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('promotion_contacts')
export class PromotionContact {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 15, nullable: true })
  whatsapp_number: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'text' })
  source: string;

  @Column({ type: 'text' })
  page_url: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}

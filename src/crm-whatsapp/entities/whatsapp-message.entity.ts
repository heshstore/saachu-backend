import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Lead } from '../../crm/entities/lead.entity';
import { User } from '../../users/entities/user.entity';

@Entity('whatsapp_messages')
export class WhatsAppMessage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  chat_id: string;

  @Column({ nullable: true })
  lead_id: number;

  @ManyToOne(() => Lead, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lead_id' })
  lead: Lead;

  @Column({ length: 10 })
  direction: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz' })
  timestamp: Date;

  @Column({ default: false })
  is_read: boolean;

  @Column({ nullable: true })
  sent_by: number;

  @ManyToOne(() => User, { nullable: true, eager: false })
  @JoinColumn({ name: 'sent_by' })
  sender: User;
}

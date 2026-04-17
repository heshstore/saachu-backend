import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('whatsapp_sessions')
export class WhatsAppSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  session_name: string;

  @Column({ default: 'DISCONNECTED' })
  status: string;

  @Column({ type: 'text', nullable: true })
  qr_code: string;

  @Column({ nullable: true })
  phone_number: string;

  @Column({ type: 'timestamptz', nullable: true })
  connected_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_active_at: Date;
}

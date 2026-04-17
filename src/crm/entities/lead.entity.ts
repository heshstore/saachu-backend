import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';

export enum LeadSource {
  INDIAMART   = 'INDIAMART',
  META_ADS    = 'META_ADS',
  GOOGLE_ADS  = 'GOOGLE_ADS',
  SHOPIFY     = 'SHOPIFY',
  WHATSAPP    = 'WHATSAPP',
  DIRECT_CALL = 'DIRECT_CALL',
  MANUAL      = 'MANUAL',
}

export enum LeadStatus {
  NEW        = 'NEW',
  CONTACTED  = 'CONTACTED',
  INTERESTED = 'INTERESTED',
  QUOTATION  = 'QUOTATION',
  CONVERTED  = 'CONVERTED',
  LOST       = 'LOST',
}

export enum LeadPriority {
  LOW    = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH   = 'HIGH',
}

@Entity('leads')
export class Lead {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ length: 10 })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 20 })
  source: LeadSource;

  @Column({ type: 'varchar', length: 20, default: LeadStatus.NEW })
  status: LeadStatus;

  @Column({ nullable: true })
  assigned_to: number;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ type: 'timestamptz', nullable: true })
  follow_up_date: Date;

  @Column({ type: 'text', nullable: true })
  product_interest: string;

  @Column({ nullable: true })
  utm_source: string;

  @Column({ nullable: true })
  utm_campaign: string;

  @Column({ type: 'varchar', length: 10, default: LeadPriority.MEDIUM })
  lead_priority: LeadPriority;

  @Column({ nullable: true })
  customer_id: number;

  @Column({ nullable: true })
  quotation_id: number;

  @Column({ nullable: true })
  whatsapp_chat_id: string;

  @Column({ type: 'jsonb', nullable: true })
  raw_payload: Record<string, any>;

  @Column({ nullable: true })
  external_id: string;

  @Column({ default: false })
  duplicate_flag: boolean;

  @Column({ default: true })
  is_active: boolean;

  @Column({ nullable: true })
  created_by: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

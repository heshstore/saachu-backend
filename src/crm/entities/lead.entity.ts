import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';

export enum LeadSource {
  SHOPIFY   = 'SHOPIFY',
  META      = 'META',
  GOOGLE    = 'GOOGLE',
  INDIAMART = 'INDIAMART',
  LINKEDIN  = 'LINKEDIN',
  WHATSAPP  = 'WHATSAPP',
  DIRECT    = 'DIRECT',
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

export enum LeadChannel {
  WHATSAPP = 'WHATSAPP',
  CALL     = 'CALL',
  FORM     = 'FORM',
}

@Entity('leads')
export class Lead {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  name: string;

  /** Stored in +E.164 format or 'unknown' for anonymous Shopify leads */
  @Column({ length: 20, nullable: true })
  phone: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  city: string;

  @Column({ nullable: true })
  state: string;

  @Column({ nullable: true })
  country: string;

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

  @Column({ type: 'varchar', length: 50, nullable: true })
  lead_source_label: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  channel: string;

  @Column({ type: 'text', nullable: true })
  landing_page: string;

  @Column({ default: false })
  duplicate_flag: boolean;

  /** Auto-computed behavioral tags: ["high_intent", "slow_response", "bulk_buyer"] */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

  @Column({ default: true })
  is_active: boolean;

  @Column({ nullable: true })
  created_by: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

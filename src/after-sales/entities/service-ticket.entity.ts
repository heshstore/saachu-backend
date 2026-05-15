import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, OneToMany,
} from 'typeorm';
import { ServiceTicketUpdate } from './service-ticket-update.entity';

export type ServiceTicketStatus =
  | 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_PARTS' | 'RESOLVED' | 'CLOSED' | 'CANCELLED';

export type ServiceTicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ServiceTicketType =
  | 'COMPLAINT' | 'INSTALLATION' | 'REPAIR' | 'AMC_VISIT' | 'DEMO' | 'INSPECTION';

@Entity('service_tickets')
export class ServiceTicket {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ name: 'ticket_number', length: 40 })
  ticketNumber: string;

  @Column({ name: 'customer_id' })
  customerId: number;

  @Column({ name: 'order_id', type: 'int', nullable: true })
  orderId: number | null;

  @Column({ name: 'dispatch_order_id', type: 'int', nullable: true })
  dispatchOrderId: number | null;

  @Column({ name: 'item_id' })
  itemId: number;

  @Column({ name: 'issue_type', length: 80, nullable: true })
  issueType: string | null;

  @Column({ name: 'issue_description', type: 'text', nullable: true })
  issueDescription: string | null;

  @Column({ default: 'MEDIUM' })
  priority: ServiceTicketPriority;

  @Column({ default: 'OPEN' })
  status: ServiceTicketStatus;

  @Column({ name: 'assigned_to', type: 'int', nullable: true })
  assignedTo: number | null;

  @Column({ name: 'service_type' })
  serviceType: ServiceTicketType;

  @Column({ name: 'warranty_status', length: 30, nullable: true })
  warrantyStatus: string | null;

  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ServiceTicketUpdate, (u) => u.ticket)
  updates: ServiceTicketUpdate[];
}

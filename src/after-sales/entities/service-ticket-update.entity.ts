import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { ServiceTicket } from './service-ticket.entity';

@Entity('service_ticket_updates')
export class ServiceTicketUpdate {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'service_ticket_id' })
  serviceTicketId: number;

  @ManyToOne(() => ServiceTicket, (t) => t.updates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_ticket_id' })
  ticket: ServiceTicket;

  @Column({ name: 'technician_id', type: 'int', nullable: true })
  technicianId: number | null;

  @Column({ name: 'visit_notes', type: 'text', nullable: true })
  visitNotes: string | null;

  @Column({ name: 'issue_findings', type: 'text', nullable: true })
  issueFindings: string | null;

  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes: string | null;

  @Column({ name: 'next_action', length: 255, nullable: true })
  nextAction: string | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

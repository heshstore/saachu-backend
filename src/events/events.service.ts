import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProductionJob } from '../orders/entities/production-job.entity';

// Typed event registry — extend as new domains are added
export type SaachuEventMap = {
  'job.assigned':       ProductionJob;
  'job.delayed':        ProductionJob;
  'job.completed':      ProductionJob;
  'order.created':      { id: number; salesman_id?: number; customer_name?: string };
  'order.completed':    { orderId: number; salesmanId?: number };
  'payment.received':   { orderId: number; amount: number; createdBy: number };
  'whatsapp.down':      { reason: string };
  'shopify.sync_failed':{ error: string; syncedAt?: Date };
  'lead.assigned':      { leadId: number; userId: number; leadName?: string };
  'lead.converted':     { leadId: number; orderId?: number };
};

@Injectable()
export class EventsService {
  constructor(private readonly emitter: EventEmitter2) {}

  emit<K extends keyof SaachuEventMap>(event: K, payload: SaachuEventMap[K]): void {
    this.emitter.emit(event as string, payload);
  }

  on<K extends keyof SaachuEventMap>(
    event: K,
    listener: (payload: SaachuEventMap[K]) => void,
  ): void {
    this.emitter.on(event as string, listener);
  }
}

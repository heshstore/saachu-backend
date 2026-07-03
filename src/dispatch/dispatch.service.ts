import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Dispatch, DispatchStatus } from './entities/dispatch.entity';
import { CreateDispatchDto } from './dto/create-dispatch.dto';
import { MarkDeliveredDto } from './dto/mark-delivered.dto';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { AuditService } from '../logs/audit.service';

@Injectable()
export class DispatchService {
  constructor(
    @InjectRepository(Dispatch)
    private readonly dispatchRepo: Repository<Dispatch>,

    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,

    private readonly audit: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Orders that can receive a new dispatch document (including partial fulfillment). */
  getReadyOrders(): Promise<Order[]> {
    return this.orderRepo.find({
      where: {
        status: In([
          OrderStatus.READY,
          OrderStatus.READY_FOR_DISPATCH,
          OrderStatus.PARTIAL_DISPATCHED,
          OrderStatus.PARTIAL_DELIVERED,
        ]),
      },
      order: { created_at: 'ASC' },
    });
  }

  /** All dispatch records joined with key order fields, newest first. */
  async findAll(): Promise<any[]> {
    return this.dispatchRepo.manager.query(`
      SELECT
        d.*,
        o.order_no,
        o.customer_name,
        o.customer_phone,
        o.total_amount
      FROM dispatches d
      LEFT JOIN orders o ON o.id = d.order_id
      ORDER BY d.created_at DESC
    `);
  }

  /**
   * Creates a dispatch record and marks the order as DISPATCHED.
   *
   * Idempotent: if a dispatch already exists for this order, returns it without
   * creating a duplicate. The unique constraint on order_id provides a DB-level
   * safety net for parallel calls that slip past the application-level check.
   */
  async createDispatch(
    dto: CreateDispatchDto,
    userId?: number,
  ): Promise<Dispatch> {
    return this.dispatchRepo.manager.transaction(async (tx) => {
      // Lock order row so a concurrent cancel cannot slip past this status check
      const order = await tx.findOne(Order, {
        where: { id: dto.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order)
        throw new NotFoundException(`Order ${dto.order_id} not found`);

      if (order.status === OrderStatus.DISPATCHED) {
        // Already dispatched — return existing record (idempotent).
        const existing = await tx.findOne(Dispatch, {
          where: { order_id: dto.order_id },
        });
        if (existing) return existing;
      }

      if (
        order.status !== OrderStatus.READY &&
        order.status !== OrderStatus.READY_FOR_DISPATCH
      ) {
        throw new BadRequestException(
          `Order must be READY to create a dispatch (current: ${order.status})`,
        );
      }

      // Check for existing dispatch (app-level guard before hitting unique constraint)
      const existing = await tx.findOne(Dispatch, {
        where: { order_id: dto.order_id },
      });
      if (existing) return existing;

      // Create dispatch
      let dispatch: Dispatch;
      try {
        dispatch = tx.create(Dispatch, {
          order_id: dto.order_id,
          dispatch_status: DispatchStatus.DISPATCHED,
          dispatch_date: new Date(),
          transport_type: dto.transport_type,
          tracking_number: dto.tracking_number ?? null,
          notes: dto.notes ?? null,
        });
        dispatch = await tx.save(dispatch);
      } catch (e: any) {
        if (e?.code === '23505') {
          // Lost the race — another request created it first; return what's there.
          const fallback = await tx.findOne(Dispatch, {
            where: { order_id: dto.order_id },
          });
          if (fallback) return fallback;
          throw new ConflictException('Dispatch already exists for this order');
        }
        throw e;
      }

      // Advance order status
      await tx.update(
        Order,
        { id: dto.order_id },
        { status: OrderStatus.DISPATCHED },
      );

      this.audit.log({
        entity: 'dispatch',
        entity_id: dispatch.id,
        action: 'CREATED',
        user_id: userId,
        meta: { order_id: dto.order_id, transport_type: dto.transport_type },
      });

      this.eventEmitter.emit('dispatch.created', {
        id: dispatch.id,
        order_id: dto.order_id,
        user_id: userId ?? null,
      });
      return dispatch;
    });
  }

  /**
   * Marks a dispatch as delivered and closes the order.
   * Idempotent: calling on an already-delivered dispatch is a no-op.
   * Returns orderUpdated=false when the order was not DISPATCHED (e.g. it was cancelled).
   */
  async markDelivered(
    dto: MarkDeliveredDto,
    userId?: number,
  ): Promise<{ dispatch: Dispatch; orderUpdated: boolean }> {
    let orderUpdated = false;

    const dispatch = await this.dispatchRepo.manager.transaction(async (tx) => {
      const d = await tx.findOne(Dispatch, {
        where: { id: dto.dispatch_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!d)
        throw new NotFoundException(`Dispatch ${dto.dispatch_id} not found`);

      // Idempotent: already delivered
      if (d.dispatch_status === DispatchStatus.DELIVERED) return d;

      d.dispatch_status = DispatchStatus.DELIVERED;
      d.delivery_date = new Date();
      await tx.save(d);

      // Only advance to COMPLETED if the order is still DISPATCHED — a concurrent
      // cancellation must win; we must not silently overwrite CANCELLED with COMPLETED.
      const order = await tx.findOne(Order, { where: { id: d.order_id } });
      if (order?.status === OrderStatus.DISPATCHED) {
        await tx.update(
          Order,
          { id: d.order_id },
          { status: OrderStatus.COMPLETED },
        );
        orderUpdated = true;
      }

      this.audit.log({
        entity: 'dispatch',
        entity_id: d.id,
        action: 'DELIVERED',
        user_id: userId,
        meta: { order_id: d.order_id, order_updated: orderUpdated },
      });

      this.eventEmitter.emit('dispatch.delivered', {
        id: d.id,
        order_id: d.order_id,
        user_id: userId ?? null,
      });
      return d;
    });

    return { dispatch, orderUpdated };
  }
}

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import {
  ServiceTicket,
  ServiceTicketStatus,
} from './entities/service-ticket.entity';
import { ServiceTicketUpdate } from './entities/service-ticket-update.entity';
import { AmcContract } from './entities/amc-contract.entity';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { InventoryService } from '../inventory/inventory.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

const EPS = 1e-6;
const DEFAULT_WARRANTY_MONTHS = 12;

const STATUS_FLOW: Record<ServiceTicketStatus, ServiceTicketStatus[]> = {
  OPEN: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'OPEN', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_PARTS', 'RESOLVED', 'CANCELLED'],
  WAITING_PARTS: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  CANCELLED: [],
};

@Injectable()
export class AfterSalesService {
  private readonly logger = new Logger(AfterSalesService.name);

  constructor(
    @InjectRepository(ServiceTicket)
    private readonly ticketRepo: Repository<ServiceTicket>,
    @InjectRepository(ServiceTicketUpdate)
    private readonly updateRepo: Repository<ServiceTicketUpdate>,
    @InjectRepository(AmcContract)
    private readonly amcRepo: Repository<AmcContract>,
    @InjectRepository(TechnicianProfile)
    private readonly techRepo: Repository<TechnicianProfile>,
    private readonly dataSource: DataSource,
    private readonly inventoryService: InventoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async nextTicketNumber(): Promise<string> {
    const rows: any[] = await this.dataSource.query(
      `SELECT nextval('service_ticket_number_seq')::bigint AS n`,
    );
    const n = String(rows[0].n).padStart(6, '0');
    const y = new Date().getFullYear();
    return `ST-${y}-${n}`;
  }

  async assertTechnicianActive(userId: number): Promise<void> {
    const t = await this.techRepo.findOne({ where: { userId, active: true } });
    if (!t)
      throw new BadRequestException(
        `User ${userId} is not an active technician`,
      );
  }

  /** Operational hint — not legal warranty certification */
  async computeWarrantyHint(params: {
    customerId: number;
    orderId: number | null;
    dispatchOrderId: number | null;
    itemId: number;
  }): Promise<{
    warrantyStatus: string;
    deliveryDate: string | null;
    warrantyExpiresAt: string | null;
    amcCoversItem: boolean;
    notes: string;
  }> {
    let delivery: Date | null = null;
    if (params.dispatchOrderId) {
      const d: any[] = await this.dataSource.query(
        `SELECT delivered_at FROM dispatch_orders WHERE id = $1`,
        [params.dispatchOrderId],
      );
      if (d[0]?.delivered_at) delivery = new Date(d[0].delivered_at);
    }
    if (!delivery && params.orderId) {
      const d: any[] = await this.dataSource.query(
        `SELECT MAX(delivered_at) AS mx
         FROM dispatch_orders
         WHERE order_id = $1 AND delivered_at IS NOT NULL
           AND status IN ('DELIVERED','PARTIAL_DELIVERED')`,
        [params.orderId],
      );
      if (d[0]?.mx) delivery = new Date(d[0].mx);
    }

    const amcRows: any[] = await this.dataSource.query(
      `SELECT id, covered_items, start_date, end_date
       FROM amc_contracts
       WHERE customer_id = $1 AND status = 'ACTIVE'
         AND CURRENT_DATE BETWEEN start_date AND end_date`,
      [params.customerId],
    );
    let amcCoversItem = false;
    for (const row of amcRows) {
      const arr: number[] = Array.isArray(row.covered_items)
        ? row.covered_items
        : [];
      if (!arr.length) continue;
      if (arr.includes(params.itemId)) amcCoversItem = true;
    }

    let warrantyExpiresAt: string | null = null;
    if (delivery) {
      const exp = new Date(delivery);
      exp.setMonth(exp.getMonth() + DEFAULT_WARRANTY_MONTHS);
      warrantyExpiresAt = exp.toISOString();
    }

    const now = Date.now();
    let underWarranty = false;
    if (delivery && warrantyExpiresAt) {
      underWarranty = now <= new Date(warrantyExpiresAt).getTime();
    }

    let warrantyStatus = 'UNKNOWN';
    let notes = '';
    if (amcCoversItem) {
      warrantyStatus = 'AMC_COVERED';
      notes = 'Active AMC lists this item as covered.';
    } else if (underWarranty) {
      warrantyStatus = 'UNDER_WARRANTY';
      notes = `Default ${DEFAULT_WARRANTY_MONTHS} month warranty from delivery (operational estimate).`;
    } else if (delivery) {
      warrantyStatus = 'CHARGEABLE';
      notes = 'Outside default warranty window; no AMC coverage for this item.';
    } else {
      notes = 'No confirmed delivery date on linked dispatch/order.';
    }

    return {
      warrantyStatus,
      deliveryDate: delivery ? delivery.toISOString() : null,
      warrantyExpiresAt,
      amcCoversItem,
      notes,
    };
  }

  async createTicket(
    body: {
      customerId: number;
      orderId?: number | null;
      dispatchOrderId?: number | null;
      itemId: number;
      issueType?: string;
      issueDescription?: string;
      priority?: string;
      serviceType: string;
      assignedTo?: number | null;
    },
    userId?: number,
  ): Promise<ServiceTicket> {
    const hint = await this.computeWarrantyHint({
      customerId: body.customerId,
      orderId: body.orderId ?? null,
      dispatchOrderId: body.dispatchOrderId ?? null,
      itemId: body.itemId,
    });

    let status: ServiceTicketStatus = 'OPEN';
    if (body.assignedTo) {
      await this.assertTechnicianActive(body.assignedTo);
      status = 'ASSIGNED';
    }

    const ticket = this.ticketRepo.create({
      ticketNumber: await this.nextTicketNumber(),
      customerId: body.customerId,
      orderId: body.orderId ?? null,
      dispatchOrderId: body.dispatchOrderId ?? null,
      itemId: body.itemId,
      issueType: body.issueType ?? null,
      issueDescription: body.issueDescription ?? null,
      priority: (body.priority as any) || 'MEDIUM',
      status,
      assignedTo: body.assignedTo ?? null,
      serviceType: body.serviceType as any,
      warrantyStatus: hint.warrantyStatus,
      createdBy: userId ?? null,
    });
    const saved = await this.ticketRepo.save(ticket);

    await this.updateRepo.save(
      this.updateRepo.create({
        serviceTicketId: saved.id,
        technicianId: body.assignedTo ?? null,
        visitNotes: `Ticket opened. ${hint.notes}`,
        createdBy: userId ?? null,
      }),
    );

    return this.getTicket(saved.id);
  }

  async listTickets(
    filters: {
      status?: string;
      customerId?: number;
      assignedTo?: number;
      limit?: number;
    } = {},
  ): Promise<any[]> {
    const params: unknown[] = [];
    const cond: string[] = ['1=1'];
    if (filters.status) {
      params.push(filters.status);
      cond.push(`t.status = $${params.length}`);
    }
    if (filters.customerId) {
      params.push(filters.customerId);
      cond.push(`t.customer_id = $${params.length}`);
    }
    if (filters.assignedTo) {
      params.push(filters.assignedTo);
      cond.push(`t.assigned_to = $${params.length}`);
    }
    const limit = Math.min(filters.limit ?? 100, 500);
    params.push(limit);
    return this.dataSource.query(
      `SELECT t.*,
              tech.name AS technician_name,
              cb.name AS created_by_name,
              cl.name AS closed_by_name,
              o.salesman_id,
              sm.name AS salesman_name, sm.mobile AS salesman_phone, sm.role AS salesman_role
       FROM service_tickets t
       LEFT JOIN "user" tech ON tech.id = t.assigned_to
       LEFT JOIN "user" cb ON cb.id = t.created_by
       LEFT JOIN "user" cl ON cl.id = t.closed_by
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN "user" sm ON sm.id = o.salesman_id
       WHERE ${cond.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
  }

  async getTicket(id: number): Promise<any> {
    const rows: any[] = await this.dataSource.query(
      `SELECT t.*,
              tech.name AS technician_name,
              cb.name AS created_by_name,
              cl.name AS closed_by_name,
              o.salesman_id, o.order_no,
              sm.name AS salesman_name, sm.mobile AS salesman_phone, sm.role AS salesman_role
       FROM service_tickets t
       LEFT JOIN "user" tech ON tech.id = t.assigned_to
       LEFT JOIN "user" cb ON cb.id = t.created_by
       LEFT JOIN "user" cl ON cl.id = t.closed_by
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN "user" sm ON sm.id = o.salesman_id
       WHERE t.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Ticket ${id} not found`);
    const updates = await this.updateRepo.find({
      where: { serviceTicketId: id },
      order: { createdAt: 'ASC' },
    });
    return { ...rows[0], updates };
  }

  async patchTicket(
    id: number,
    body: {
      status?: ServiceTicketStatus;
      priority?: string;
      assignedTo?: number | null;
      issueDescription?: string;
      resolutionNotes?: string;
    },
    userId?: number,
  ): Promise<ServiceTicket> {
    const t = await this.ticketRepo.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Ticket ${id} not found`);

    if (body.assignedTo !== undefined) {
      if (body.assignedTo != null)
        await this.assertTechnicianActive(body.assignedTo);
      t.assignedTo = body.assignedTo;
      if (body.assignedTo != null && t.status === 'OPEN') t.status = 'ASSIGNED';
    }
    if (body.priority) t.priority = body.priority as any;
    if (body.issueDescription !== undefined)
      t.issueDescription = body.issueDescription;
    if (body.resolutionNotes !== undefined)
      t.resolutionNotes = body.resolutionNotes;

    if (body.status && body.status !== t.status) {
      const allowed = STATUS_FLOW[t.status] || [];
      if (!allowed.includes(body.status)) {
        throw new BadRequestException(
          `Cannot move from ${t.status} to ${body.status}`,
        );
      }
      t.status = body.status;
      if (body.status === 'RESOLVED' && !t.resolvedAt) {
        t.resolvedAt = new Date();
      }
      if (body.status === 'CLOSED') {
        t.closedBy = userId ?? t.closedBy ?? null;
        t.closedAt = new Date();
      }
    }

    const hint = await this.computeWarrantyHint({
      customerId: t.customerId,
      orderId: t.orderId,
      dispatchOrderId: t.dispatchOrderId,
      itemId: t.itemId,
    });
    t.warrantyStatus = hint.warrantyStatus;

    await this.ticketRepo.save(t);
    if (body.status === 'CLOSED') {
      let userName: string | null = null;
      if (userId) {
        const [u] = await this.dataSource.query(
          `SELECT name FROM "user" WHERE id = $1`,
          [userId],
        );
        userName = u?.name ?? null;
      }
      this.eventEmitter.emit('service.ticket.closed', {
        ticket_id: id,
        ticket_number: t.ticketNumber,
        user_id: userId ?? null,
        user_name: userName,
      });
    }
    return this.getTicket(id);
  }

  async addTicketUpdate(
    ticketId: number,
    body: {
      visitNotes?: string;
      issueFindings?: string;
      resolutionNotes?: string;
      nextAction?: string;
      technicianId?: number | null;
    },
    userId?: number,
  ): Promise<ServiceTicketUpdate> {
    await this.getTicket(ticketId);
    if (body.technicianId != null)
      await this.assertTechnicianActive(body.technicianId);

    const u = this.updateRepo.create({
      serviceTicketId: ticketId,
      technicianId: body.technicianId ?? userId ?? null,
      visitNotes: body.visitNotes ?? null,
      issueFindings: body.issueFindings ?? null,
      resolutionNotes: body.resolutionNotes ?? null,
      nextAction: body.nextAction ?? null,
      createdBy: userId ?? null,
    });
    return this.updateRepo.save(u);
  }

  async consumeSpare(
    ticketId: number,
    body: {
      itemId: number;
      warehouseId: number;
      qty: number;
      rate?: number | null;
      notes?: string;
    },
    userId?: number,
  ): Promise<{ transaction: unknown; ticket: ServiceTicket }> {
    await this.getTicket(ticketId);
    const qty = Number(body.qty);
    if (!qty || qty <= EPS) throw new BadRequestException('qty must be > 0');

    const balRows: any[] = await this.dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN qty WHEN direction = 'OUT' THEN -qty ELSE 0 END),0)::float AS q
       FROM inventory_transactions WHERE item_id = $1 AND warehouse_id = $2`,
      [body.itemId, body.warehouseId],
    );
    const bal = Number(balRows[0]?.q) || 0;
    if (bal + EPS < qty) {
      throw new BadRequestException(
        `Insufficient stock: have ${bal}, need ${qty}`,
      );
    }

    const tx = await this.inventoryService.createTransaction(
      {
        itemId: body.itemId,
        warehouseId: body.warehouseId,
        transactionType: 'SERVICE_SPARE_USE',
        direction: 'OUT',
        qty,
        unit: 'PCS',
        rate: body.rate ?? null,
        referenceType: 'SERVICE_TICKET',
        referenceId: ticketId,
        notes: body.notes ?? `Service ticket ${ticketId}`,
      },
      userId,
    );

    const t = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (t && t.status === 'OPEN') {
      t.status = 'IN_PROGRESS';
      await this.ticketRepo.save(t);
    } else if (t && t.status === 'ASSIGNED') {
      t.status = 'IN_PROGRESS';
      await this.ticketRepo.save(t);
    }

    return { transaction: tx, ticket: await this.getTicket(ticketId) };
  }

  // ── AMC ─────────────────────────────────────────────────────────────────────

  async listAmc(customerId?: number): Promise<AmcContract[]> {
    const qb = this.amcRepo.createQueryBuilder('a').orderBy('a.endDate', 'ASC');
    if (customerId) qb.andWhere('a.customerId = :c', { c: customerId });
    return qb.getMany();
  }

  async createAmc(body: {
    customerId: number;
    orderId?: number | null;
    startDate: string;
    endDate: string;
    visitFrequency?: string;
    coveredItems?: number[];
    notes?: string;
  }): Promise<AmcContract> {
    const row = this.amcRepo.create({
      customerId: body.customerId,
      orderId: body.orderId ?? null,
      startDate: body.startDate,
      endDate: body.endDate,
      visitFrequency: body.visitFrequency ?? null,
      coveredItems: body.coveredItems ?? [],
      status: 'ACTIVE',
      notes: body.notes ?? null,
    });
    return this.amcRepo.save(row);
  }

  async patchAmc(
    id: number,
    body: Partial<{
      status: string;
      notes: string;
      visitFrequency: string;
      coveredItems: number[];
      endDate: string;
    }>,
  ): Promise<AmcContract> {
    const a = await this.amcRepo.findOne({ where: { id } });
    if (!a) throw new NotFoundException(`AMC ${id} not found`);
    Object.assign(a, body);
    return this.amcRepo.save(a);
  }

  // ── Technicians ─────────────────────────────────────────────────────────────

  async listTechnicians(): Promise<any[]> {
    return this.dataSource.query(
      `SELECT tp.*, u.name AS "userName", u.mobile AS "userMobile"
       FROM technician_profiles tp
       JOIN "user" u ON u.id = tp.user_id
       ORDER BY u.name ASC`,
    );
  }

  async upsertTechnician(body: {
    userId: number;
    department?: string;
    specialization?: string;
    active?: boolean;
    remarks?: string;
  }): Promise<TechnicianProfile> {
    let row = await this.techRepo.findOne({ where: { userId: body.userId } });
    if (!row) {
      row = this.techRepo.create({
        userId: body.userId,
        department: body.department ?? null,
        specialization: body.specialization ?? null,
        active: body.active !== false,
        remarks: body.remarks ?? null,
      });
    } else {
      if (body.department !== undefined) row.department = body.department;
      if (body.specialization !== undefined)
        row.specialization = body.specialization;
      if (body.active !== undefined) row.active = body.active;
      if (body.remarks !== undefined) row.remarks = body.remarks;
    }
    return this.techRepo.save(row);
  }

  async deactivateTechnician(userId: number): Promise<TechnicianProfile> {
    const row = await this.techRepo.findOne({ where: { userId } });
    if (!row)
      throw new NotFoundException(
        `Technician profile for user ${userId} not found`,
      );
    row.active = false;
    return this.techRepo.save(row);
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────

  async getDashboard(): Promise<Record<string, unknown>> {
    const [open, waitingParts, overdue, workload, renewals, repeat] =
      await Promise.all([
        this.ticketRepo.count({
          where: {
            status: In(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_PARTS']),
          },
        }),
        this.ticketRepo.count({ where: { status: 'WAITING_PARTS' } }),
        this.dataSource.query(`
        SELECT COUNT(*)::int AS c FROM service_tickets
        WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING_PARTS')
          AND created_at < now() - interval '7 days'
      `),
        this.dataSource.query(`
        SELECT t.assigned_to AS "userId", u.name AS "userName", COUNT(*)::int AS cnt
        FROM service_tickets t
        LEFT JOIN "user" u ON u.id = t.assigned_to
        WHERE t.status IN ('ASSIGNED','IN_PROGRESS','WAITING_PARTS')
        GROUP BY t.assigned_to, u.name
        ORDER BY cnt DESC
        LIMIT 12
      `),
        this.dataSource.query(`
        SELECT id, customer_id AS "customerId", end_date AS "endDate", visit_frequency AS "visitFrequency"
        FROM amc_contracts
        WHERE status = 'ACTIVE' AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '30 days'
        ORDER BY end_date ASC
        LIMIT 20
      `),
        this.dataSource.query(`
        SELECT customer_id AS "customerId", item_id AS "itemId", COUNT(*)::int AS cnt
        FROM service_tickets
        WHERE service_type = 'COMPLAINT'
        GROUP BY customer_id, item_id
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
        LIMIT 15
      `),
      ]);

    return {
      openTickets: open,
      waitingParts,
      overdueTickets: Number(overdue[0]?.c) || 0,
      technicianWorkload: workload,
      amcRenewalsDue: renewals,
      repeatComplaintPairs: repeat,
    };
  }

  // ── Customer lifecycle (read-only aggregation) ─────────────────────────────

  /** Lets service staff pick a warehouse without inventory.view */
  listWarehousesForService() {
    return this.inventoryService.findAllWarehouses(false);
  }

  async getCustomerLifecycle(
    customerId: number,
  ): Promise<Record<string, unknown>> {
    const [orders, dispatches, tickets, amcs] = await Promise.all([
      this.dataSource.query(
        `SELECT id, order_no, status, total_amount, created_at
         FROM orders WHERE customer_id = $1 ORDER BY id DESC LIMIT 40`,
        [customerId],
      ),
      this.dataSource.query(
        `SELECT d.id, d.dispatch_number, d.status, d.order_id, d.delivered_at, d.created_at
         FROM dispatch_orders d
         JOIN orders o ON o.id = d.order_id
         WHERE o.customer_id = $1
         ORDER BY d.id DESC LIMIT 40`,
        [customerId],
      ),
      this.ticketRepo.find({
        where: { customerId },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
      this.amcRepo.find({ where: { customerId }, order: { endDate: 'ASC' } }),
    ]);

    return { orders, dispatches, tickets, amcContracts: amcs };
  }
}

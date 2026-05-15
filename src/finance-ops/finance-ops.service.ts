import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaymentService, AddPaymentDto } from '../orders/payment.service';
import { PaymentMode } from '../orders/entities/payment.entity';
import { OrderStatus } from '../orders/entities/order.entity';
import {
  FinancePaymentMode,
  FinancePaymentType,
} from './entities/payment-entry.entity';

const INELIGIBLE_ORDER_STATUSES: string[] = [
  OrderStatus.DRAFT,
  OrderStatus.GENERATED,
  OrderStatus.PENDING_APPROVAL,
  OrderStatus.REJECTED,
];

export interface FinanceDashboardSummary {
  total_receivables_outstanding: number;
  total_payables_outstanding: number;
  overdue_receivables_amount: number;
  overdue_payables_amount: number;
  overdue_receivables_count: number;
  overdue_payables_count: number;
  expected_incoming_30d: number;
  expected_outgoing_30d: number;
  customer_exposure: number;
  vendor_exposure: number;
}

export interface FinanceWarning {
  code: string;
  severity: 'warn' | 'info';
  message: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class FinanceOpsService {
  private readonly log = new Logger(FinanceOpsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly paymentService: PaymentService,
  ) {}

  private num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** OVERDUE overrides PARTIAL when due date passed and still outstanding. */
  deriveStatus(outstanding: number, received: number, dueRaw: unknown): 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE' {
    if (outstanding <= 0.005) return 'PAID';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dueRaw) {
      const d = new Date(dueRaw as string);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(0, 0, 0, 0);
        if (today > d && outstanding > 0) return 'OVERDUE';
      }
    }
    if (received > 0.005) return 'PARTIAL';
    return 'PENDING';
  }

  async syncCustomerReceivable(orderId: number): Promise<void> {
    const [order] = await this.ds.query(
      `SELECT id, customer_id, status, total_amount, due_date
       FROM orders WHERE id = $1`,
      [orderId],
    );
    if (!order) return;

    if (!order.customer_id || INELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      await this.ds.query(`DELETE FROM customer_receivables WHERE order_id = $1`, [orderId]);
      return;
    }

    if (order.status === OrderStatus.CANCELLED) {
      await this.ds.query(`DELETE FROM customer_receivables WHERE order_id = $1`, [orderId]);
      return;
    }

    const [{ sum }] = await this.ds.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS sum FROM payments WHERE order_id = $1`,
      [orderId],
    );
    const total = this.num(order.total_amount);
    const received = this.num(sum);
    const outstanding = Math.max(0, total - received);
    const status = this.deriveStatus(outstanding, received, order.due_date);

    await this.ds.query(
      `INSERT INTO customer_receivables
        (customer_id, order_id, total_order_value, received_amount, outstanding_amount, due_date, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, ($6::timestamptz)::date, $7, now())
       ON CONFLICT (order_id) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         total_order_value = EXCLUDED.total_order_value,
         received_amount = EXCLUDED.received_amount,
         outstanding_amount = EXCLUDED.outstanding_amount,
         due_date = EXCLUDED.due_date,
         status = EXCLUDED.status,
         updated_at = now()`,
      [order.customer_id, orderId, total, received, outstanding, order.due_date ?? null, status],
    );
  }

  async syncVendorPayable(purchaseOrderId: number): Promise<void> {
    const [po] = await this.ds.query(
      `SELECT id, vendor_id, total_amount, status, expected_date, order_date
       FROM purchase_orders WHERE id = $1`,
      [purchaseOrderId],
    );
    if (!po) return;

    if (po.status === 'CANCELLED') {
      await this.ds.query(`DELETE FROM vendor_payables WHERE purchase_order_id = $1`, [purchaseOrderId]);
      return;
    }

    const [{ sum }] = await this.ds.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payment_entries
       WHERE payment_type = 'VENDOR_PAYMENT'
         AND reference_type = 'PURCHASE_ORDER'
         AND reference_id = $1`,
      [purchaseOrderId],
    );
    const total = this.num(po.total_amount);
    const paid = this.num(sum);
    const outstanding = Math.max(0, total - paid);
    const dueDate = po.expected_date || po.order_date || null;
    const status = this.deriveStatus(outstanding, paid, dueDate);

    await this.ds.query(
      `INSERT INTO vendor_payables
        (vendor_id, purchase_order_id, total_po_value, paid_amount, outstanding_amount, due_date, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, now())
       ON CONFLICT (purchase_order_id) DO UPDATE SET
         vendor_id = EXCLUDED.vendor_id,
         total_po_value = EXCLUDED.total_po_value,
         paid_amount = EXCLUDED.paid_amount,
         outstanding_amount = EXCLUDED.outstanding_amount,
         due_date = EXCLUDED.due_date,
         status = EXCLUDED.status,
         updated_at = now()`,
      [po.vendor_id, purchaseOrderId, total, paid, outstanding, dueDate, status],
    );
  }

  /**
   * Creates a payment_entries row for a `payments` row (idempotent via linked_payment_id).
   */
  async ensurePaymentEntryForLinkedPayment(paymentId: number): Promise<void> {
    const [pay] = await this.ds.query(
      `SELECT id, order_id, amount, payment_mode, payment_reference, notes, created_by
       FROM payments WHERE id = $1`,
      [paymentId],
    );
    if (!pay) return;

    const [ord] = await this.ds.query(
      `SELECT customer_id FROM orders WHERE id = $1`,
      [pay.order_id],
    );
    const customerId = ord?.customer_id ?? null;
    const modeUpper = this.mapLegacyPaymentModeToFinance(String(pay.payment_mode || 'cash'));

    await this.ds.query(
      `INSERT INTO payment_entries
        (payment_type, reference_type, reference_id, customer_id, vendor_id, amount, payment_mode, payment_date, remarks, created_by, linked_payment_id)
       VALUES ('CUSTOMER_RECEIPT', 'ORDER', $1, $2, NULL, $3, $4::varchar, CURRENT_DATE, $5, $6, $7)
       ON CONFLICT (linked_payment_id) DO NOTHING`,
      [
        pay.order_id,
        customerId,
        this.num(pay.amount),
        modeUpper,
        [pay.notes, pay.payment_reference].filter(Boolean).join(' · ') || null,
        pay.created_by ?? null,
        paymentId,
      ],
    );
  }

  mapLegacyPaymentModeToFinance(mode: string): FinancePaymentMode {
    const m = (mode || '').toLowerCase();
    if (m === 'upi') return 'UPI';
    if (m === 'bank') return 'BANK';
    return 'CASH';
  }

  /** Map UI / operational modes to PaymentService (cash | upi | bank). */
  mapFinanceModeToLegacy(mode: FinancePaymentMode): { legacy: PaymentMode; finance: FinancePaymentMode } {
    const u = String(mode || '').toUpperCase() as FinancePaymentMode;
    if (u === 'UPI') return { legacy: 'upi', finance: 'UPI' };
    if (u === 'CASH') return { legacy: 'cash', finance: 'CASH' };
    return { legacy: 'bank', finance: u === 'CHEQUE' || u === 'OTHER' ? u : 'BANK' };
  }

  async addCustomerReceipt(body: {
    orderId: number;
    amount: number;
    paymentMode: FinancePaymentMode;
    paymentReference?: string;
    remarks?: string;
    idempotencyKey?: string;
  }, userId?: number) {
    const { legacy, finance } = this.mapFinanceModeToLegacy(body.paymentMode);
    let ref = body.paymentReference?.trim() || '';
    if (['upi', 'bank'].includes(legacy) && !ref) {
      ref = `${finance}-${Date.now()}`;
    }
    const dto: AddPaymentDto = {
      amount: body.amount,
      payment_mode: legacy,
      payment_reference: ref || undefined,
      idempotency_key: body.idempotencyKey,
      notes: body.remarks,
    };
    const summary = await this.paymentService.addPayment(body.orderId, dto, userId);
    const payments = await this.paymentService.getPayments(body.orderId);
    const last = payments[payments.length - 1];
    if (last?.id) {
      await this.ensurePaymentEntryForLinkedPayment(last.id);
      await this.ds.query(
        `UPDATE payment_entries SET payment_mode = $1::varchar, remarks = COALESCE($2, remarks)
         WHERE linked_payment_id = $3`,
        [body.paymentMode, body.remarks ?? null, last.id],
      );
    }
    await this.syncCustomerReceivable(body.orderId);
    return summary;
  }

  async addVendorPayment(body: {
    purchaseOrderId: number;
    amount: number;
    paymentMode: FinancePaymentMode;
    paymentDate?: string;
    remarks?: string;
  }, userId?: number) {
    if (body.amount <= 0) throw new BadRequestException('Amount must be positive');

    const [po] = await this.ds.query(
      `SELECT id, vendor_id, status, total_amount FROM purchase_orders WHERE id = $1`,
      [body.purchaseOrderId],
    );
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'CANCELLED') throw new BadRequestException('PO is cancelled');

    const [{ sum }] = await this.ds.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payment_entries
       WHERE payment_type = 'VENDOR_PAYMENT'
         AND reference_type = 'PURCHASE_ORDER'
         AND reference_id = $1`,
      [body.purchaseOrderId],
    );
    const paid = this.num(sum);
    const total = this.num(po.total_amount);
    const pending = Math.max(0, total - paid);
    if (body.amount > pending + 0.01) {
      throw new BadRequestException(
        `Amount exceeds PO outstanding ₹${pending.toFixed(2)}`,
      );
    }

    const mode = String(body.paymentMode || 'BANK').toUpperCase() as FinancePaymentMode;
    const dateStr = body.paymentDate || new Date().toISOString().slice(0, 10);

    await this.ds.query(
      `INSERT INTO payment_entries
        (payment_type, reference_type, reference_id, customer_id, vendor_id, amount, payment_mode, payment_date, remarks, created_by, linked_payment_id)
       VALUES ('VENDOR_PAYMENT', 'PURCHASE_ORDER', $1, NULL, $2, $3, $4, $5::date, $6, $7, NULL)`,
      [
        body.purchaseOrderId,
        po.vendor_id,
        body.amount,
        mode,
        dateStr,
        body.remarks ?? null,
        userId ?? null,
      ],
    );

    await this.syncVendorPayable(body.purchaseOrderId);
    return this.ds.query(`SELECT * FROM vendor_payables WHERE purchase_order_id = $1`, [body.purchaseOrderId]);
  }

  async listReceivables(filters: { status?: string; customerId?: number } = {}) {
    const params: unknown[] = [];
    const cond: string[] = [
      `o.status NOT IN ('CANCELLED','REJECTED','DRAFT','GENERATED','PENDING_APPROVAL')`,
    ];
    if (filters.status) {
      params.push(filters.status);
      cond.push(`cr.status = $${params.length}`);
    }
    if (filters.customerId) {
      params.push(filters.customerId);
      cond.push(`cr.customer_id = $${params.length}`);
    }
    return this.ds.query(
      `SELECT cr.*, o.order_no, o.status AS order_status, o.customer_name
       FROM customer_receivables cr
       JOIN orders o ON o.id = cr.order_id
       WHERE ${cond.join(' AND ')}
       ORDER BY cr.outstanding_amount DESC NULLS LAST, cr.id DESC
       LIMIT 500`,
      params,
    );
  }

  async listPayables(filters: { status?: string; vendorId?: number } = {}) {
    const params: unknown[] = [];
    const cond: string[] = [`po.status <> 'CANCELLED'`];
    if (filters.status) {
      params.push(filters.status);
      cond.push(`vp.status = $${params.length}`);
    }
    if (filters.vendorId) {
      params.push(filters.vendorId);
      cond.push(`vp.vendor_id = $${params.length}`);
    }
    return this.ds.query(
      `SELECT vp.*, po.po_number, po.status AS po_status
       FROM vendor_payables vp
       JOIN purchase_orders po ON po.id = vp.purchase_order_id
       WHERE ${cond.join(' AND ')}
       ORDER BY vp.outstanding_amount DESC NULLS LAST, vp.id DESC
       LIMIT 500`,
      params,
    );
  }

  async listPaymentEntries(filters: {
    paymentType?: FinancePaymentType;
    customerId?: number;
    vendorId?: number;
    from?: string;
    to?: string;
  } = {}) {
    const params: unknown[] = [];
    const cond: string[] = ['1=1'];
    if (filters.paymentType) {
      params.push(filters.paymentType);
      cond.push(`pe.payment_type = $${params.length}`);
    }
    if (filters.customerId) {
      params.push(filters.customerId);
      cond.push(`pe.customer_id = $${params.length}`);
    }
    if (filters.vendorId) {
      params.push(filters.vendorId);
      cond.push(`pe.vendor_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      cond.push(`pe.payment_date >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      cond.push(`pe.payment_date <= $${params.length}::date`);
    }
    return this.ds.query(
      `SELECT pe.*, o.order_no
       FROM payment_entries pe
       LEFT JOIN orders o ON o.id = pe.reference_id AND pe.reference_type = 'ORDER'
       WHERE ${cond.join(' AND ')}
       ORDER BY pe.payment_date DESC, pe.id DESC
       LIMIT 500`,
      params,
    );
  }

  async getCustomerFinanceSummary(customerId: number) {
    const orders = await this.ds.query(
      `SELECT id, order_no, status, total_amount, paid_amount, pending_amount, due_date, created_at
       FROM orders
       WHERE customer_id = $1
       ORDER BY id DESC
       LIMIT 40`,
      [customerId],
    );
    const receivables = await this.ds.query(
      `SELECT cr.*, o.order_no, o.status AS order_status
       FROM customer_receivables cr
       JOIN orders o ON o.id = cr.order_id
       WHERE cr.customer_id = $1
       ORDER BY cr.id DESC`,
      [customerId],
    );
    const payments = await this.ds.query(
      `SELECT * FROM payment_entries
       WHERE customer_id = $1 AND payment_type = 'CUSTOMER_RECEIPT'
       ORDER BY payment_date DESC, id DESC
       LIMIT 50`,
      [customerId],
    );
    const [{ overdue }] = await this.ds.query(
      `SELECT COALESCE(SUM(cr.outstanding_amount), 0)::numeric AS overdue
       FROM customer_receivables cr
       WHERE cr.customer_id = $1 AND cr.status = 'OVERDUE'`,
      [customerId],
    );
    const [cust] = await this.ds.query(
      `SELECT id, "companyName" AS company_name, "creditLimit" AS credit_limit FROM customer WHERE id = $1`,
      [customerId],
    );
    return {
      customer: cust || null,
      orders,
      receivables,
      payments,
      overdueAmount: this.num(overdue),
    };
  }

  async getVendorFinanceSummary(vendorId: number) {
    const pos = await this.ds.query(
      `SELECT id, po_number, status, total_amount, expected_date, order_date
       FROM purchase_orders
       WHERE vendor_id = $1
       ORDER BY id DESC
       LIMIT 40`,
      [vendorId],
    );
    const payables = await this.ds.query(
      `SELECT vp.*, po.po_number, po.status AS po_status
       FROM vendor_payables vp
       JOIN purchase_orders po ON po.id = vp.purchase_order_id
       WHERE vp.vendor_id = $1
       ORDER BY vp.id DESC`,
      [vendorId],
    );
    const payments = await this.ds.query(
      `SELECT * FROM payment_entries
       WHERE vendor_id = $1 AND payment_type = 'VENDOR_PAYMENT'
       ORDER BY payment_date DESC, id DESC
       LIMIT 50`,
      [vendorId],
    );
    const [{ overdue }] = await this.ds.query(
      `SELECT COALESCE(SUM(vp.outstanding_amount), 0)::numeric AS overdue
       FROM vendor_payables vp
       WHERE vp.vendor_id = $1 AND vp.status = 'OVERDUE'`,
      [vendorId],
    );
    return { purchaseOrders: pos, payables, payments, overdueAmount: this.num(overdue) };
  }

  async getWarnings(): Promise<FinanceWarning[]> {
    const out: FinanceWarning[] = [];

    const overdueR = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM customer_receivables WHERE status = 'OVERDUE'`,
    );
    if (this.num(overdueR[0]?.c) > 0) {
      out.push({
        code: 'OVERDUE_RECEIVABLES',
        severity: 'warn',
        message: `${overdueR[0].c} customer receivable row(s) are overdue.`,
        meta: { count: overdueR[0].c },
      });
    }

    const overdueP = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM vendor_payables WHERE status = 'OVERDUE'`,
    );
    if (this.num(overdueP[0]?.c) > 0) {
      out.push({
        code: 'OVERDUE_PAYABLES',
        severity: 'warn',
        message: `${overdueP[0].c} vendor payable row(s) are overdue.`,
        meta: { count: overdueP[0].c },
      });
    }

    const creditRows = await this.ds.query(`
      SELECT c.id, c."companyName" AS name, c."creditLimit" AS credit_limit,
             COALESCE(SUM(cr.outstanding_amount), 0)::numeric AS exposure
      FROM customer c
      INNER JOIN customer_receivables cr ON cr.customer_id = c.id
      WHERE c."creditLimit" IS NOT NULL AND c."creditLimit" > 0
      GROUP BY c.id, c."companyName", c."creditLimit"
      HAVING COALESCE(SUM(cr.outstanding_amount), 0) > c."creditLimit"
      LIMIT 20
    `);
    for (const row of creditRows) {
      out.push({
        code: 'CREDIT_LIMIT_EXCEEDED',
        severity: 'warn',
        message: `Customer "${row.name}" outstanding (₹${this.num(row.exposure).toFixed(0)}) exceeds credit limit (₹${this.num(row.credit_limit).toFixed(0)}).`,
        meta: { customerId: row.id, exposure: this.num(row.exposure), limit: this.num(row.credit_limit) },
      });
    }

    return out;
  }

  async getDashboardSummary(): Promise<FinanceDashboardSummary> {
    const defaults: FinanceDashboardSummary = {
      total_receivables_outstanding: 0,
      total_payables_outstanding: 0,
      overdue_receivables_amount: 0,
      overdue_payables_amount: 0,
      overdue_receivables_count: 0,
      overdue_payables_count: 0,
      expected_incoming_30d: 0,
      expected_outgoing_30d: 0,
      customer_exposure: 0,
      vendor_exposure: 0,
    };

    try {
      const [r1] = await this.ds.query(`
        SELECT COALESCE(SUM(cr.outstanding_amount), 0)::numeric AS v
        FROM customer_receivables cr
        INNER JOIN orders o ON o.id = cr.order_id
        WHERE o.status NOT IN ('CANCELLED','REJECTED','DRAFT','GENERATED','PENDING_APPROVAL')
          AND cr.outstanding_amount > 0
      `);
      const [r2] = await this.ds.query(`
        SELECT COALESCE(SUM(vp.outstanding_amount), 0)::numeric AS v
        FROM vendor_payables vp
        INNER JOIN purchase_orders po ON po.id = vp.purchase_order_id
        WHERE po.status <> 'CANCELLED' AND vp.outstanding_amount > 0
      `);
      const [r3] = await this.ds.query(`
        SELECT COALESCE(SUM(outstanding_amount), 0)::numeric AS v, COUNT(*)::int AS c
        FROM customer_receivables WHERE status = 'OVERDUE'
      `);
      const [r4] = await this.ds.query(`
        SELECT COALESCE(SUM(outstanding_amount), 0)::numeric AS v, COUNT(*)::int AS c
        FROM vendor_payables WHERE status = 'OVERDUE'
      `);
      const [r5] = await this.ds.query(`
        SELECT COALESCE(SUM(cr.outstanding_amount), 0)::numeric AS v
        FROM customer_receivables cr
        INNER JOIN orders o ON o.id = cr.order_id
        WHERE o.status NOT IN ('CANCELLED','REJECTED','DRAFT','GENERATED','PENDING_APPROVAL')
          AND cr.outstanding_amount > 0
          AND cr.due_date IS NOT NULL
          AND cr.due_date > CURRENT_DATE
          AND cr.due_date <= CURRENT_DATE + INTERVAL '30 days'
      `);
      const [r6] = await this.ds.query(`
        SELECT COALESCE(SUM(vp.outstanding_amount), 0)::numeric AS v
        FROM vendor_payables vp
        INNER JOIN purchase_orders po ON po.id = vp.purchase_order_id
        WHERE po.status <> 'CANCELLED'
          AND vp.outstanding_amount > 0
          AND vp.due_date IS NOT NULL
          AND vp.due_date > CURRENT_DATE
          AND vp.due_date <= CURRENT_DATE + INTERVAL '30 days'
      `);

      defaults.total_receivables_outstanding = this.num(r1?.v);
      defaults.total_payables_outstanding = this.num(r2?.v);
      defaults.overdue_receivables_amount = this.num(r3?.v);
      defaults.overdue_receivables_count = Math.round(this.num(r3?.c));
      defaults.overdue_payables_amount = this.num(r4?.v);
      defaults.overdue_payables_count = Math.round(this.num(r4?.c));
      defaults.expected_incoming_30d = this.num(r5?.v);
      defaults.expected_outgoing_30d = this.num(r6?.v);
      defaults.customer_exposure = defaults.total_receivables_outstanding;
      defaults.vendor_exposure = defaults.total_payables_outstanding;
    } catch (e) {
      this.log.warn(`Finance dashboard query skipped: ${(e as Error).message}`);
    }

    return defaults;
  }

  /** Backfill / repair — optional admin use */
  async resyncAllOpen(): Promise<{ receivables: number; payables: number }> {
    const orders = await this.ds.query(
      `SELECT id FROM orders
       WHERE status NOT IN ('DRAFT','GENERATED','PENDING_APPROVAL','REJECTED')
       ORDER BY id DESC
       LIMIT 2000`,
    );
    for (const row of orders) {
      await this.syncCustomerReceivable(row.id);
    }
    const pos = await this.ds.query(`SELECT id FROM purchase_orders ORDER BY id DESC LIMIT 2000`);
    for (const row of pos) {
      await this.syncVendorPayable(row.id);
    }
    return { receivables: orders.length, payables: pos.length };
  }
}

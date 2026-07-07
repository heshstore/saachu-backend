import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationService } from '../notifications/notification.service';
import { CrmWhatsAppService } from '../crm-whatsapp/crm-whatsapp.service';
import { DbHealthService } from '../shared/db-health.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../notifications/notification.entity';

const STAFF_REMINDER_LEAD_DAYS = 3; // first staff nudge starts 3 days before due date
const STAFF_COOLDOWN_MINUTES = 23 * 60; // once per day, via NotificationService's own dedup

interface ReminderRow {
  id: number;
  order_id: number;
  outstanding_amount: string;
  due_date: string;
  last_customer_reminder_sent: string | null;
  order_no: string;
  salesman_id: number | null;
  customer_id: number;
  company_name: string;
  mobile1: string;
}

@Injectable()
export class PaymentRemindersService {
  private readonly logger = new Logger(PaymentRemindersService.name);
  private _running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifService: NotificationService,
    private readonly whatsapp: CrmWhatsAppService,
    private readonly dbHealth: DbHealthService,
  ) {}

  // ── Cron: daily at 9am ────────────────────────────────────────────────────────

  @Cron('0 9 * * *')
  async runDailyReminders(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      const rows: ReminderRow[] = await this.ds.query(`
        SELECT cr.id, cr.order_id, cr.outstanding_amount, cr.due_date,
               cr.last_customer_reminder_sent,
               o.order_no, o.salesman_id,
               c.id AS customer_id, c."companyName" AS company_name, c.mobile1
        FROM customer_receivables cr
        JOIN orders o ON o.id = cr.order_id
        JOIN customer c ON c.id = cr.customer_id
        WHERE cr.outstanding_amount > 0
          AND cr.due_date IS NOT NULL
          AND c.stop_payment_reminder = false
          AND o.status NOT IN ('CANCELLED', 'REJECTED', 'DRAFT', 'GENERATED', 'PENDING_APPROVAL')
      `);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const row of rows) {
        await this.processRow(row, today).catch((e: any) =>
          this.logger.warn(
            `Payment reminder failed for receivable ${row.id}: ${e?.message}`,
          ),
        );
      }
    } catch (e: any) {
      this.dbHealth.handleError(e, 'PaymentReminders.runDailyReminders');
    } finally {
      this._running = false;
    }
  }

  private async processRow(row: ReminderRow, today: Date): Promise<void> {
    const dueDate = new Date(row.due_date);
    dueDate.setHours(0, 0, 0, 0);
    const daysUntilDue = Math.round(
      (dueDate.getTime() - today.getTime()) / 86_400_000,
    );
    const outstanding = Number(row.outstanding_amount);

    // ── Staff leg — starts 3 days before due date, then daily ──────────────────
    if (daysUntilDue <= STAFF_REMINDER_LEAD_DAYS && row.salesman_id) {
      const overdue = daysUntilDue < 0;
      await this.notifService.createNotification({
        user_id: row.salesman_id,
        type: NotificationType.REMINDER,
        priority: overdue
          ? NotificationPriority.CRITICAL
          : NotificationPriority.HIGH,
        category: NotificationCategory.ACCOUNTS,
        title: overdue
          ? `Payment overdue — ${row.order_no}`
          : `Payment due in ${daysUntilDue} day(s) — ${row.order_no}`,
        message: overdue
          ? `${row.company_name} has an overdue balance of ₹${outstanding.toFixed(2)} on order ${row.order_no}.`
          : `${row.company_name}'s payment of ₹${outstanding.toFixed(2)} on order ${row.order_no} is due in ${daysUntilDue} day(s).`,
        entity_type: 'customer_receivable',
        entity_id: row.id,
        action_url: `/orders/${row.order_id}`,
        cooldownMinutes: STAFF_COOLDOWN_MINUTES,
        is_automated: true,
      });
    }

    // ── Customer leg — starts on the due date, then daily ──────────────────────
    const todayStr = today.toISOString().slice(0, 10);
    if (
      daysUntilDue <= 0 &&
      row.mobile1 &&
      row.last_customer_reminder_sent !== todayStr
    ) {
      const digits = row.mobile1.replace(/\D/g, '').slice(-10);
      if (digits.length === 10) {
        const message =
          daysUntilDue < 0
            ? `Dear ${row.company_name}, your payment of ₹${outstanding.toFixed(2)} for order ${row.order_no} is overdue. Please arrange payment at the earliest.`
            : `Dear ${row.company_name}, your payment of ₹${outstanding.toFixed(2)} for order ${row.order_no} is due today. Please arrange payment.`;
        await this.whatsapp.sendToPhone(`91${digits}`, message);
        await this.ds.query(
          `UPDATE customer_receivables SET last_customer_reminder_sent = $2 WHERE id = $1`,
          [row.id, todayStr],
        );
      }
    }
  }
}

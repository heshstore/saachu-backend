import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationService } from '../notifications/notification.service';
import { NotificationType, NotificationPriority } from '../notifications/notification.entity';
import { LeadSource, LeadStatus } from './entities/lead.entity';

export interface LeadCreatedEvent {
  id:              number;
  name:            string;
  phone:           string | null;
  source:          LeadSource;
  assigned_to:     number | null;
  product_interest: string | null;
}

export interface LeadStatusChangedEvent {
  id:           number;
  name:         string;
  phone:        string | null;
  assigned_to:  number | null;
  prev_status:  string;
  new_status:   string;
  product_interest: string | null;
}

// Sources for which we send an outbound WhatsApp greeting to the customer.
// WHATSAPP leads already initiated contact — no auto-reply needed.
const AUTO_REPLY_SOURCES: LeadSource[] = [
  LeadSource.META,
  LeadSource.INDIAMART,
  LeadSource.GOOGLE,
  LeadSource.LINKEDIN,
];

@Injectable()
export class LeadAutomationService {
  private readonly logger = new Logger(LeadAutomationService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly waService: WhatsAppService,
    private readonly notifService: NotificationService,
  ) {}

  // ── 1. New lead auto-response ────────────────────────────────────────────────

  @OnEvent('crm.lead.created', { async: true })
  async handleLeadCreated(ev: LeadCreatedEvent): Promise<void> {
    // Notify salesman in-app (always)
    if (ev.assigned_to) {
      await this.notifService.createNotification({
        user_id:        ev.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          'New lead assigned',
        message:        `${ev.name}${ev.phone ? ` · ${ev.phone}` : ''} — ${ev.product_interest ?? 'General enquiry'}`,
        entity_type:    'lead',
        entity_id:      ev.id,
        cooldownMinutes: 5,
        is_automated:    true,
      });

      await this.safeWaSendToUser(
        ev.assigned_to,
        `🔔 *New Lead Assigned*\n` +
        `Name: ${ev.name}\n` +
        `Phone: ${ev.phone ?? 'Not provided'}\n` +
        `Interest: ${ev.product_interest ?? 'General enquiry'}\n` +
        `Source: ${ev.source}\n\n` +
        `Open the CRM to view details.`,
      );
    }

    // Auto-greet customer for high-intent inbound sources (not WhatsApp — they messaged us first)
    if (ev.phone && AUTO_REPLY_SOURCES.includes(ev.source) && await this.isSetting('automation.lead_greeting')) {
      await this.safeWaSendToPhone(
        ev.phone,
        `Namaste ${ev.name.split(' ')[0]}! 🙏\n\n` +
        `Thank you for your interest in *${ev.product_interest ?? 'our products'}*.\n\n` +
        `Our team will call you shortly. Meanwhile, could you let us know — *what quantity are you looking for?* This will help us prepare the best quote for you.\n\n` +
        `— Saachu`,
      );
    }
  }

  // ── 2. Customer replied on WhatsApp — notify salesman instantly ──────────────

  @OnEvent('whatsapp.customer_replied', { async: true })
  async handleCustomerReplied(ev: {
    leadId: number; leadName: string; assignedTo: number; messageBody: string;
  }): Promise<void> {
    const preview = ev.messageBody.length > 100
      ? `${ev.messageBody.slice(0, 100)}…`
      : ev.messageBody;

    const notif = await this.notifService.createNotification({
      user_id:        ev.assignedTo,
      type:           NotificationType.ACTION,
      priority:       NotificationPriority.HIGH,
      title:          `${ev.leadName} replied on WhatsApp`,
      message:        preview,
      entity_type:    'lead',
      entity_id:      ev.leadId,
      cooldownMinutes: 10,
      is_automated:    true,
    });

    if (notif) {
      await this.safeWaSendToUser(
        ev.assignedTo,
        `💬 *${ev.leadName}* replied:\n"${preview}"\n\nReply now — they're active.`,
      );
    }
  }

  // ── 3. Status-change triggers ─────────────────────────────────────────────────

  @OnEvent('crm.lead.status_changed', { async: true })
  async handleStatusChanged(ev: LeadStatusChangedEvent): Promise<void> {
    if (!ev.assigned_to) return;

    if (ev.new_status === LeadStatus.INTERESTED) {
      const notif = await this.notifService.createNotification({
        user_id:        ev.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          'Lead interested — send quotation',
        message:        `${ev.name} is interested in ${ev.product_interest ?? 'your product'}. Create a quotation now.`,
        entity_type:    'lead',
        entity_id:      ev.id,
        cooldownMinutes: 60,
        is_automated:    true,
      });
      if (notif) {
        await this.safeWaSendToUser(
          ev.assigned_to,
          `💡 *Lead Interested — Action Required*\n` +
          `${ev.name}${ev.phone ? ` (${ev.phone})` : ''} is interested in *${ev.product_interest ?? 'your product'}*.\n\n` +
          `Please prepare and send a quotation as soon as possible.`,
        );
      }
      return;
    }

    if (ev.new_status === LeadStatus.QUOTATION) {
      const notif = await this.notifService.createNotification({
        user_id:        ev.assigned_to,
        type:           NotificationType.REMINDER,
        priority:       NotificationPriority.HIGH,
        title:          'Quotation sent — follow up in 3 days',
        message:        `${ev.name} has a quotation for ${ev.product_interest ?? 'your product'}. Set a reminder to close.`,
        entity_type:    'lead',
        entity_id:      ev.id,
        cooldownMinutes: 120,
        is_automated:    true,
      });
      if (notif) {
        await this.safeWaSendToUser(
          ev.assigned_to,
          `📋 *Quotation Stage — Action Required*\n` +
          `${ev.name}${ev.phone ? ` (${ev.phone})` : ''} has received a quotation for *${ev.product_interest ?? 'your product'}*.\n\n` +
          `Follow up in 2–3 days. If no reply, you will receive another reminder automatically.`,
        );
      }
      return;
    }

    if (ev.new_status === LeadStatus.CONVERTED) {
      await this.notifService.createNotification({
        user_id:        ev.assigned_to,
        type:           NotificationType.MOTIVATION,
        priority:       NotificationPriority.LOW,
        title:          'Deal closed! 🎉',
        message:        `${ev.name} has been converted. Great work!`,
        entity_type:    'lead',
        entity_id:      ev.id,
        cooldownMinutes: 5,
        is_automated:    true,
      });
    }
  }

  // ── Settings helper ───────────────────────────────────────────────────────────

  private async recordLastRun(cronKey: string): Promise<void> {
    await this.ds.query(
      `INSERT INTO crm_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [cronKey, new Date().toISOString()],
    );
  }

  private async isSetting(key: string, defaultOn = true): Promise<boolean> {
    const rows: { value: string }[] = await this.ds.query(
      `SELECT value FROM crm_settings WHERE key = $1 LIMIT 1`,
      [key],
    );
    if (!rows.length) return defaultOn;
    return rows[0].value !== 'false';
  }

  // ── 3. Overdue follow-up reminder (every 30 min) ──────────────────────────────

  @Cron('*/30 * * * *')
  async remindOverdueFollowUps(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;
    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; status: string;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.status
       FROM leads l
       WHERE l.follow_up_date < NOW()
         AND l.status NOT IN ('CONVERTED', 'LOST')
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
         AND (l.last_customer_reply_at IS NULL OR l.last_customer_reply_at < NOW() - INTERVAL '6 hours')
       ORDER BY l.follow_up_date ASC
       LIMIT 50`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      const notif = await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.REMINDER,
        priority:       NotificationPriority.HIGH,
        title:          'Follow-up overdue',
        message:        `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — ${lead.product_interest ?? 'General enquiry'} [${lead.status}]`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 60,
        is_automated:    true,
      });

      if (notif) {
        await this.safeWaSendToUser(
          lead.assigned_to,
          `⏰ *Follow-up Overdue*\n` +
          `Lead: ${lead.name}\n` +
          `Phone: ${lead.phone ?? 'N/A'}\n` +
          `Interest: ${lead.product_interest ?? 'General enquiry'}\n` +
          `Status: ${lead.status}\n\n` +
          `Please follow up immediately.`,
        );
      }
    }

    this.logger.log(`remindOverdueFollowUps: processed ${leads.length} overdue lead(s)`);
    await this.recordLastRun('cron.followup_reminders.last_run');
  }

  // ── 4. Missed lead recovery (daily 9 AM) ──────────────────────────────────────

  @Cron('0 9 * * *')
  async recoverMissedLeads(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;
    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; source: string;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.source
       FROM leads l
       WHERE l.status = 'NEW'
         AND l.created_at < NOW() - INTERVAL '24 hours'
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY l.created_at ASC
       LIMIT 100`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      const notif = await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          'Uncontacted lead — 24h+',
        message:        `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} from ${lead.source} hasn't been contacted yet.`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 360,
        is_automated:    true,
      });

      if (notif) {
        await this.safeWaSendToUser(
          lead.assigned_to,
          `⚠️ *Uncontacted Lead — 24h+*\n` +
          `Lead: ${lead.name}\n` +
          `Phone: ${lead.phone ?? 'N/A'}\n` +
          `Source: ${lead.source}\n` +
          `Interest: ${lead.product_interest ?? 'General enquiry'}\n\n` +
          `This lead has not been contacted for over 24 hours. Please call now.`,
        );
      }
    }

    this.logger.log(`recoverMissedLeads: found ${leads.length} uncontacted lead(s)`);
    await this.recordLastRun('cron.missed_leads.last_run');
  }

  // ── 5. INTERESTED leads with no quotation after 48h ─────────────────────────

  @Cron('0 */3 * * *')
  async nudgeQuotationPending(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; updated_at: string;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.updated_at
       FROM leads l
       WHERE l.status = 'INTERESTED'
         AND l.quotation_id IS NULL
         AND l.updated_at < NOW() - INTERVAL '48 hours'
         AND l.updated_at > NOW() - INTERVAL '7 days'
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY l.updated_at ASC
       LIMIT 30`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      const hoursStale = Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 3_600_000);
      const notif = await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          'Quotation not sent — lead going cold',
        message:        `${lead.name} has been INTERESTED for ${hoursStale}h but has no quotation. Send one now before they move on.`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 360,
        is_automated:    true,
      });

      if (notif) {
        await this.safeWaSendToUser(
          lead.assigned_to,
          `🚨 *Quotation Not Sent — ${hoursStale}h Overdue*\n` +
          `Lead: ${lead.name}\n` +
          `Interest: ${lead.product_interest ?? 'General enquiry'}\n\n` +
          `You marked this lead as *INTERESTED* ${hoursStale} hours ago but haven't sent a quotation yet. ` +
          `Send it now — leads that wait >48h rarely convert.`,
        );
      }
    }

    this.logger.log(`nudgeQuotationPending: found ${leads.length} INTERESTED lead(s) with no quotation`);
  }

  // ── 6. Customer follow-up after quotation (daily 11 AM) ──────────────────────

  @Cron('0 11 * * *')
  async followUpWithCustomerOnQuotation(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string; assigned_to: number;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to
       FROM leads l
       WHERE l.status = 'QUOTATION'
         AND l.phone IS NOT NULL
         AND l.updated_at < NOW() - INTERVAL '2 days'
         AND l.updated_at > NOW() - INTERVAL '6 days'
         AND l.is_active = true
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
         AND (l.last_customer_reply_at IS NULL OR l.last_customer_reply_at < NOW() - INTERVAL '48 hours')
         AND (
           SELECT COUNT(*) FROM whatsapp_messages wm
           WHERE wm.lead_id = l.id
             AND wm.direction = 'OUTBOUND'
             AND wm.sent_by IS NULL
         ) < 3
       ORDER BY l.updated_at ASC
       LIMIT 40`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      await this.safeWaSendToPhone(
        lead.phone,
        `Namaste ${lead.name.split(' ')[0]}! 👋\n\n` +
        `We shared a quotation with you for *${lead.product_interest ?? 'our products'}*.\n\n` +
        `Do you have any questions about the pricing or specifications? We are happy to adjust the quote to fit your requirements.\n\n` +
        `Just reply here and we will get back to you within the hour.\n\n` +
        `— Saachu`,
      );

      await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.INFO,
        priority:       NotificationPriority.LOW,
        title:          'Auto follow-up sent to customer',
        message:        `Sent quotation follow-up WhatsApp to ${lead.name}.`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 1440,
        is_automated:    true,
      });
    }

    this.logger.log(`followUpWithCustomerOnQuotation: sent follow-up to ${leads.length} customer(s)`);
    await this.recordLastRun('cron.customer_quotation_followup.last_run');
  }

  // ── 7. Hot lead first-contact alert (every 15 min) ───────────────────────────
  // Source-specific urgency windows:
  //   META/GOOGLE : alert 45 min–4 h   (ad click, hot intent, moves on fast)
  //   INDIAMART   : alert 2 h–8 h      (B2B buyer, checks periodically)
  //   LINKEDIN    : alert 3 h–10 h     (professional context, slower cycle)

  private static readonly HOT_LEAD_WINDOWS: Record<string, { minH: number; maxH: number; emoji: string; label: string }> = {
    META:      { minH: 0.75, maxH: 4,  emoji: '🔥', label: 'Meta ad lead' },
    GOOGLE:    { minH: 0.75, maxH: 4,  emoji: '🔥', label: 'Google ad lead' },
    INDIAMART: { minH: 2,    maxH: 8,  emoji: '⚡', label: 'IndiaMart enquiry' },
    LINKEDIN:  { minH: 3,    maxH: 10, emoji: '⚡', label: 'LinkedIn lead' },
  };

  @Cron('*/15 * * * *')
  async alertHotLeadNotContacted(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; source: string; created_at: string;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.source, l.created_at
       FROM leads l
       WHERE l.status = 'NEW'
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
         AND (
           (l.source IN ('META', 'GOOGLE')
            AND l.created_at BETWEEN NOW() - INTERVAL '4 hours' AND NOW() - INTERVAL '45 minutes')
           OR
           (l.source = 'INDIAMART'
            AND l.created_at BETWEEN NOW() - INTERVAL '8 hours' AND NOW() - INTERVAL '2 hours')
           OR
           (l.source = 'LINKEDIN'
            AND l.created_at BETWEEN NOW() - INTERVAL '10 hours' AND NOW() - INTERVAL '3 hours')
         )
       ORDER BY l.created_at ASC
       LIMIT 20`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      const minsOld = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 60_000);
      const w = LeadAutomationService.HOT_LEAD_WINDOWS[lead.source];
      const emoji = w?.emoji ?? '⚡';
      const label = w?.label ?? lead.source;

      const notif = await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          `${emoji} ${label} uncontacted — ${minsOld}m`,
        message:        `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — ${lead.product_interest ?? 'General enquiry'}`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 60,
        is_automated:    true,
      });

      if (notif) {
        await this.safeWaSendToUser(
          lead.assigned_to,
          `${emoji} *${label} — ${minsOld}m old, not contacted*\n` +
          `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''}\n` +
          `${lead.product_interest ?? 'General enquiry'}\n\n` +
          `Call now before they enquire elsewhere.`,
        );
      }
    }

    this.logger.log(`alertHotLeadNotContacted: ${leads.length} hot lead(s) uncontacted`);
  }

  // ── 8. Unanswered customer reply — salesman hasn't responded in 30 min ────────

  @Cron('*/15 * * * *')
  async alertUnansweredCustomerReply(): Promise<void> {
    const leads: Array<{
      id: number; assigned_to: number; name: string; product_interest: string;
    }> = await this.ds.query(
      `SELECT l.id, l.assigned_to, l.name, l.product_interest
       FROM leads l
       WHERE l.status NOT IN ('CONVERTED', 'LOST')
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
         AND l.last_customer_reply_at IS NOT NULL
         AND l.last_customer_reply_at < NOW() - INTERVAL '30 minutes'
         AND l.last_customer_reply_at > NOW() - INTERVAL '6 hours'
         AND (l.last_salesman_reply_at IS NULL OR l.last_salesman_reply_at < l.last_customer_reply_at)
       LIMIT 20`,
    );

    if (!leads.length) return;

    for (const lead of leads) {
      await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          `${lead.name} is waiting for your reply`,
        message:        `Customer replied on WhatsApp 30+ min ago with no response yet.`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 30,
        is_automated:    true,
      });
    }

    this.logger.log(`alertUnansweredCustomerReply: ${leads.length} unanswered reply/replies`);
  }

  // ── 9. Auto-resume snoozed automation (every 30 min) ─────────────────────────

  @Cron('*/30 * * * *')
  async resumeExpiredSnoozes(): Promise<void> {
    const result: Array<{ id: number }> = await this.ds.query(
      `UPDATE leads
       SET tags                   = (
             SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
             FROM   jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb)) AS t
             WHERE  t <> 'automation_off'
           ),
           automation_snooze_until  = NULL,
           automation_snooze_reason = NULL,
           updated_at               = NOW()
       WHERE automation_snooze_until IS NOT NULL
         AND automation_snooze_until < NOW()
         AND is_active = true
       RETURNING id`,
    );

    if (result.length) {
      this.logger.log(`resumeExpiredSnoozes: resumed automation for ${result.length} lead(s)`);
    }
  }

  // ── 10. Payment follow-ups (daily 10 AM) ──────────────────────────────────────

  @Cron('0 10 * * *')
  async paymentFollowUps(): Promise<void> {
    if (!await this.isSetting('automation.payment_followups')) return;
    const orders: Array<{
      id: number; order_no: string; customer_name: string;
      pending_amount: string; salesman_id: number;
    }> = await this.ds.query(
      `SELECT o.id, o.order_no, o.customer_name, o.pending_amount, o.salesman_id
       FROM orders o
       WHERE o.status = 'COMPLETED'
         AND o.pending_amount > 0
         AND o.updated_at < NOW() - INTERVAL '3 days'
         AND o.salesman_id IS NOT NULL
       ORDER BY o.pending_amount DESC
       LIMIT 50`,
    );

    if (!orders.length) return;

    for (const order of orders) {
      const pending = Number(order.pending_amount).toLocaleString('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 0,
      });

      const notif = await this.notifService.createNotification({
        user_id:        order.salesman_id,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.MEDIUM,
        title:          'Payment pending',
        message:        `${order.customer_name} · ${order.order_no ?? `ORD-${order.id}`} — ${pending} outstanding`,
        entity_type:    'order',
        entity_id:      order.id,
        cooldownMinutes: 1440,
        is_automated:    true,
      });

      if (notif) {
        await this.safeWaSendToUser(
          order.salesman_id,
          `💰 *Payment Reminder*\n` +
          `Customer: ${order.customer_name}\n` +
          `Order: ${order.order_no ?? `ORD-${order.id}`}\n` +
          `Pending: ${pending}\n\n` +
          `Please follow up with the customer to collect the remaining payment.`,
        );
      }
    }

    this.logger.log(`paymentFollowUps: found ${orders.length} order(s) with pending payment`);
    await this.recordLastRun('cron.payment_followups.last_run');
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async safeWaSendToUser(userId: number, message: string): Promise<void> {
    try {
      await this.waService.sendToAssignee(userId, message);
    } catch (e: any) {
      this.logger.warn(`WA send to user ${userId} failed: ${e?.message}`);
    }
  }

  private async safeWaSendToPhone(phone: string, message: string): Promise<void> {
    const digits = phone.replace(/\D/g, '');
    if (!digits || digits.length < 10) return;
    try {
      await this.waService.sendToPhone(digits, message);
    } catch (e: any) {
      this.logger.warn(`WA send to phone ${phone} failed: ${e?.message}`);
    }
  }

  // ── 10. Auto-priority elevation (every 6 hours) ───────────────────────────────
  // LOW → MEDIUM after 24h no activity; MEDIUM → HIGH after 24h no activity.
  // Skips TRACKING_ONLY / JUNK / DUPLICATE leads and automation_off leads.

  @Cron('0 */6 * * *')
  async autoPriorityElevation(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const lowToMedium: Array<{ id: number; name: string; assigned_to: number }> = await this.ds.query(`
      UPDATE leads
      SET lead_priority = 'MEDIUM', updated_at = NOW()
      WHERE lead_priority = 'LOW'
        AND status NOT IN ('CONVERTED', 'LOST')
        AND is_active = true
        AND updated_at < NOW() - INTERVAL '24 hours'
        AND (lead_quality IS NULL OR lead_quality NOT IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE'))
        AND NOT (COALESCE(tags, '[]'::jsonb) ? 'automation_off')
      RETURNING id, name, assigned_to
    `);

    const medToHigh: Array<{ id: number; name: string; assigned_to: number }> = await this.ds.query(`
      UPDATE leads
      SET lead_priority = 'HIGH', updated_at = NOW()
      WHERE lead_priority = 'MEDIUM'
        AND status NOT IN ('CONVERTED', 'LOST')
        AND is_active = true
        AND updated_at < NOW() - INTERVAL '24 hours'
        AND (lead_quality IS NULL OR lead_quality NOT IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE'))
        AND NOT (COALESCE(tags, '[]'::jsonb) ? 'automation_off')
      RETURNING id, name, assigned_to
    `);

    for (const lead of medToHigh) {
      if (!lead.assigned_to) continue;
      await this.notifService.createNotification({
        user_id:         lead.assigned_to,
        type:            NotificationType.ACTION,
        priority:        NotificationPriority.HIGH,
        title:           'Lead priority auto-elevated to HIGH',
        message:         `${lead.name} — no activity in 24h. Priority raised automatically.`,
        entity_type:     'lead',
        entity_id:       lead.id,
        cooldownMinutes: 360,
        is_automated:    true,
      });
    }

    const total = (lowToMedium?.length ?? 0) + (medToHigh?.length ?? 0);
    if (total > 0) {
      this.logger.log(
        `autoPriorityElevation: ${lowToMedium?.length ?? 0} LOW→MEDIUM, ${medToHigh?.length ?? 0} MEDIUM→HIGH`,
      );
    }
    await this.recordLastRun('cron.priority_elevation.last_run');
  }

  // ── 11. Auto-reassign stale leads (every 12 hours) ───────────────────────────
  // Leads with no activity in 48h are reassigned to the least-loaded active telecaller.

  @Cron('0 */12 * * *')
  async autoReassignStaleLeads(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const stale: Array<{ id: number; name: string; phone: string; assigned_to: number; source: string }> =
      await this.ds.query(`
        SELECT id, name, phone, assigned_to, source
        FROM leads
        WHERE status NOT IN ('CONVERTED', 'LOST')
          AND is_active = true
          AND assigned_to IS NOT NULL
          AND updated_at < NOW() - INTERVAL '48 hours'
          AND (lead_quality IS NULL OR lead_quality NOT IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE'))
          AND NOT (COALESCE(tags, '[]'::jsonb) ? 'automation_off')
          AND NOT (COALESCE(tags, '[]'::jsonb) ? 'auto_reassigned')
        ORDER BY updated_at ASC
        LIMIT 20
      `);

    if (!stale.length) return;

    for (const lead of stale) {
      try {
        // Pick least-loaded active telecaller (excluding current assignee)
        const candidates: Array<{ id: number }> = await this.ds.query(`
          SELECT u.id
          FROM "user" u
          WHERE u.role IN ('Tele calling Executive', 'Territory Manager', 'Field Executive')
            AND u.is_active = true
            AND u.id != $1
          ORDER BY (
            SELECT COUNT(*) FROM leads l2
            WHERE l2.assigned_to = u.id
              AND l2.status NOT IN ('CONVERTED', 'LOST')
              AND l2.is_active = true
          ) ASC
          LIMIT 1
        `, [lead.assigned_to]);

        if (!candidates.length) continue;
        const newAssigneeId = candidates[0].id;
        const oldAssigneeId = lead.assigned_to;

        await this.ds.query(
          `UPDATE leads
           SET assigned_to = $1,
               updated_at  = NOW(),
               tags        = COALESCE(tags, '[]'::jsonb) || '["auto_reassigned"]'::jsonb
           WHERE id = $2`,
          [newAssigneeId, lead.id],
        );

        await this.notifService.createNotification({
          user_id:         oldAssigneeId,
          type:            NotificationType.INFO,
          priority:        NotificationPriority.LOW,
          title:           'Lead auto-reassigned',
          message:         `${lead.name} was reassigned after 48h of no activity.`,
          entity_type:     'lead',
          entity_id:       lead.id,
          cooldownMinutes: 1440,
          is_automated:    true,
        });

        await this.notifService.createNotification({
          user_id:         newAssigneeId,
          type:            NotificationType.ACTION,
          priority:        NotificationPriority.HIGH,
          title:           'Lead reassigned to you',
          message:         `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — transferred from inactive salesman. Follow up now.`,
          entity_type:     'lead',
          entity_id:       lead.id,
          cooldownMinutes: 60,
          is_automated:    true,
        });

        await this.safeWaSendToUser(
          newAssigneeId,
          `📋 *Lead Reassigned to You*\n` +
          `Name: ${lead.name}\n` +
          `Phone: ${lead.phone ?? 'N/A'}\n` +
          `Source: ${lead.source}\n\n` +
          `Previous salesman had no activity for 48+ hours. Please follow up immediately.`,
        );
      } catch (e: any) {
        this.logger.warn(`autoReassignStaleLeads: failed for lead ${lead.id}: ${e?.message}`);
      }
    }

    this.logger.log(`autoReassignStaleLeads: processed ${stale.length} stale lead(s)`);
    await this.recordLastRun('cron.auto_reassign.last_run');
  }

  // ── 12. Reactivation engine (daily 10:30 AM) ─────────────────────────────────
  // Surfaces converted customers who've had no activity in 90+ days.
  // Notifies the assigned salesman with a re-engagement opportunity.
  // Does NOT create new leads — tags the existing lead to track sent notifications.

  @Cron('30 10 * * *')
  async reactivationEngine(): Promise<void> {
    const candidates: Array<{ id: number; name: string; phone: string; product_interest: string; assigned_to: number }> =
      await this.ds.query(`
        SELECT id, name, phone, product_interest, assigned_to
        FROM leads
        WHERE status = 'CONVERTED'
          AND is_active = true
          AND assigned_to IS NOT NULL
          AND updated_at < NOW() - INTERVAL '90 days'
          AND NOT (COALESCE(tags, '[]'::jsonb) ? 'reactivation_sent')
        ORDER BY updated_at ASC
        LIMIT 20
      `);

    if (!candidates.length) return;

    for (const lead of candidates) {
      await this.notifService.createNotification({
        user_id:         lead.assigned_to,
        type:            NotificationType.ACTION,
        priority:        NotificationPriority.MEDIUM,
        title:           'Reactivation opportunity',
        message:         `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — past customer, 90+ days inactive. Reach out for repeat business.`,
        entity_type:     'lead',
        entity_id:       lead.id,
        cooldownMinutes: 10080, // 7 days — one notification per week max
        is_automated:    true,
      });

      await this.ds.query(
        `UPDATE leads
         SET tags = COALESCE(tags, '[]'::jsonb) || '["reactivation_sent"]'::jsonb
         WHERE id = $1`,
        [lead.id],
      );
    }

    this.logger.log(`reactivationEngine: ${candidates.length} reactivation opportunity/ies surfaced`);
    await this.recordLastRun('cron.reactivation.last_run');
  }
}

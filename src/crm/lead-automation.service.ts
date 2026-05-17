import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationService } from '../notifications/notification.service';
import { NotificationType, NotificationPriority } from '../notifications/notification.entity';
import { LeadSource, LeadStatus, WorkflowState } from './entities/lead.entity';

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

export interface LeadEscalatedEvent {
  id:               number;
  name:             string;
  phone:            string | null;
  assigned_to:      number | null;
  product_interest: string | null;
  reason:           string;
  no_answer_count:  number;
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

  // ── WA Circuit Breaker (memory-only, no DB) ───────────────────────────────────
  // 3 failures within 10 minutes → block WA sends to that user for 30 minutes.

  private readonly waFailureMap = new Map<number, {
    count: number; lastFailureAt: number; blockedUntil: number;
  }>();

  private isWaBlocked(userId: number): boolean {
    const entry = this.waFailureMap.get(userId);
    if (!entry) return false;
    if (Date.now() > entry.blockedUntil) { this.waFailureMap.delete(userId); return false; }
    return true;
  }

  private recordWaFailure(userId: number): void {
    const now   = Date.now();
    const entry = this.waFailureMap.get(userId) ?? { count: 0, lastFailureAt: 0, blockedUntil: 0 };
    if (now - entry.lastFailureAt > 10 * 60_000) entry.count = 0;
    entry.count++;
    entry.lastFailureAt = now;
    if (entry.count >= 3 && entry.blockedUntil <= now) {
      entry.blockedUntil = now + 30 * 60_000;
      this.logger.warn(`[WA_SUPPRESS] user=${userId} blocked 30m (${entry.count} failures in window)`);
    }
    this.waFailureMap.set(userId, entry);
  }

  // ── Escalation cooldown (persisted via lead_audit_logs) ───────────────────────

  private async wasRecentlyEscalated(
    leadId: number,
    escalationType: string,
    withinMinutes: number,
  ): Promise<boolean> {
    try {
      const rows: Array<{ count: string }> = await this.ds.query(`
        SELECT COUNT(*) AS count
        FROM lead_audit_logs
        WHERE lead_id = $1
          AND action = 'ESCALATED'
          AND detail LIKE $2
          AND created_at > NOW() - ($3 * INTERVAL '1 minute')
      `, [leadId, `%${escalationType}%`, withinMinutes]);
      return parseInt(rows[0]?.count ?? '0', 10) > 0;
    } catch {
      return false; // fail open — don't suppress escalations on DB error
    }
  }

  private async markEscalated(leadId: number, escalationType: string): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO lead_audit_logs (lead_id, action, detail, created_at)
         VALUES ($1, 'ESCALATED', $2, NOW())`,
        [leadId, `${escalationType}: automated escalation`],
      );
    } catch (e: any) {
      this.logger.warn(`markEscalated failed for lead ${leadId}: ${e?.message}`);
    }
  }

  // ── Escalation tag helper ─────────────────────────────────────────────────────

  private async addEscTagIfMissing(leadId: number, tag: string): Promise<void> {
    await this.ds.query(
      `UPDATE leads
       SET tags = COALESCE(tags, '[]'::jsonb) || $2::jsonb
       WHERE id = $1
         AND NOT (COALESCE(tags, '[]'::jsonb) ? $3)`,
      [leadId, JSON.stringify([tag]), tag],
    );
  }

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

  // ── 3. Lead escalation — notify all managers ─────────────────────────────────

  @OnEvent('crm.lead.escalated', { async: true })
  async handleLeadEscalated(ev: LeadEscalatedEvent): Promise<void> {
    // 12h cooldown per lead — prevents repeated manager flooding
    if (await this.wasRecentlyEscalated(ev.id, 'MANAGER_REVIEW', 720)) {
      this.logger.debug(`[ESC] Lead ${ev.id} — MANAGER_REVIEW cooldown active, skipping`);
      return;
    }

    const managers: Array<{ id: number }> = await this.ds.query(`
      SELECT id FROM "user"
      WHERE role IN ('Admin', 'COO', 'Sales Manager')
        AND is_active = true
    `);

    for (const manager of managers) {
      await this.notifService.createNotification({
        user_id:         manager.id,
        type:            NotificationType.ACTION,
        priority:        NotificationPriority.HIGH,
        title:           `Lead escalated — ${ev.name}`,
        message:         ev.reason,
        entity_type:     'lead',
        entity_id:       ev.id,
        cooldownMinutes: 720,
        is_automated:    true,
      });

      await this.safeWaSendToUser(
        manager.id,
        `🚨 *Lead Escalated*\n` +
        `Lead: ${ev.name}${ev.phone ? ` · ${ev.phone}` : ''}\n` +
        `Interest: ${ev.product_interest ?? 'General enquiry'}\n` +
        `Reason: ${ev.reason}\n\n` +
        `Please review and take action.`,
      );
    }

    await this.markEscalated(ev.id, 'MANAGER_REVIEW');
    this.logger.log(`[ESC] handleLeadEscalated: notified ${managers.length} manager(s) for lead ${ev.id} — ${ev.reason}`);
  }

  // ── 4. Status-change triggers ─────────────────────────────────────────────────

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
  // Priority A (instant WA+notif): CALLBACK_WAIT, SEND_QUOTATION, CHASE_QUOTATION,
  //                                NO_ANSWER_ESC, needs_manager_review
  // Priority B (notif only):       FIRST_CALL overdue, NEGOTIATING
  // Priority C (notif only >24h):  FOLLOW_UP, NO_ANSWER_1, NO_ANSWER_2
  // Manager digest: ONE summary per manager per cycle — not one per lead

  @Cron('*/30 * * * *')
  async remindOverdueFollowUps(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const COOLDOWNS = {
      SLA_BREACH:   60,   // 1h
      CALLBACK:     15,   // 15m
      NO_ANSWER_ESC: 360, // 6h
    };

    // ── A. Priority-tiered SLA breach ─────────────────────────────────────────
    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; workflow_state: string; next_action_due_at: string; tags: any;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to,
              l.workflow_state, l.next_action_due_at, l.tags
       FROM leads l
       WHERE l.next_action_due_at < NOW()
         AND l.workflow_state NOT IN ('CONVERTED', 'LOST', 'NURTURE', 'CALLBACK_WAIT', 'NO_ANSWER_ESC')
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
         AND (l.last_customer_reply_at IS NULL OR l.last_customer_reply_at < NOW() - INTERVAL '6 hours')
       ORDER BY l.next_action_due_at ASC
       LIMIT 50`,
    );

    let slaBreachCount = 0;
    for (const lead of leads) {
      if (await this.wasRecentlyEscalated(lead.id, 'SLA_BREACH', COOLDOWNS.SLA_BREACH)) continue;

      const overdueMs = Date.now() - new Date(lead.next_action_due_at).getTime();
      const overdueH  = overdueMs / 3_600_000;
      const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];

      // Priority tier: A = instant WA, B = notif only, C = notif only if >24h
      const isA = ['SEND_QUOTATION', 'CHASE_QUOTATION'].includes(lead.workflow_state);
      const isB = ['FIRST_CALL', 'NEGOTIATING'].includes(lead.workflow_state);
      const sendWa = isA || (isB && overdueH > 2) || overdueH > 24;

      // Escalation progression via tags (advance only, never regress)
      let title = 'Follow-up overdue';
      let newEscTag: string | null = null;
      const hasSlaNot     = tags.includes('esc_sla_notified');
      const hasMgrNot     = tags.includes('esc_manager_notified');
      const hasReassigned = tags.includes('esc_reassigned');
      const hasFinal      = tags.includes('esc_final_warning');

      if (!hasSlaNot) {
        title = 'Follow-up overdue';
        newEscTag = 'esc_sla_notified';
      } else if (!hasMgrNot && overdueH >= 24) {
        title = '⚠️ SLA breach — 24h+ overdue';
        newEscTag = 'esc_manager_notified';
      } else if (!hasReassigned && overdueH >= 72) {
        title = '🔴 Critical: SLA breach 72h — review required';
        newEscTag = 'esc_reassigned';
      } else if (!hasFinal && overdueH >= 168) {
        title = '🚨 Final warning: lead 7d+ overdue';
        newEscTag = 'esc_final_warning';
      } else if (hasSlaNot && overdueH < 24) {
        // Already notified, in cooldown window — skip Priority C
        if (!isA && !isB) continue;
        title = 'Follow-up overdue';
      }

      this.logger.log(`[SLA] Lead ${lead.id} overdue by ${Math.round(overdueH)}h [${lead.workflow_state}]`);

      const notif = await this.notifService.createNotification({
        user_id:         lead.assigned_to,
        type:            NotificationType.REMINDER,
        priority:        isA ? NotificationPriority.HIGH : NotificationPriority.MEDIUM,
        title,
        message:         `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — ${lead.product_interest ?? 'General enquiry'} [${lead.workflow_state}]`,
        entity_type:     'lead',
        entity_id:       lead.id,
        cooldownMinutes: COOLDOWNS.SLA_BREACH,
        is_automated:    true,
      });

      if (notif) {
        await this.markEscalated(lead.id, 'SLA_BREACH');
        slaBreachCount++;
        if (newEscTag) await this.addEscTagIfMissing(lead.id, newEscTag);

        if (sendWa) {
          await this.safeWaSendToUser(
            lead.assigned_to,
            `⏰ *Follow-up Overdue*\n` +
            `Lead: ${lead.name}\n` +
            `Phone: ${lead.phone ?? 'N/A'}\n` +
            `Interest: ${lead.product_interest ?? 'General enquiry'}\n` +
            `Stage: ${lead.workflow_state} · ${Math.round(overdueH)}h overdue\n\n` +
            `Please follow up immediately.`,
          );
        }
      }
    }

    // ── B. CALLBACK_WAIT breach — Priority A always ───────────────────────────
    const callbackBreaches: Array<{
      id: number; name: string; phone: string; product_interest: string; assigned_to: number;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to
       FROM leads l
       WHERE l.workflow_state = 'CALLBACK_WAIT'
         AND l.next_action_due_at < NOW()
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY l.next_action_due_at ASC
       LIMIT 30`,
    );

    let callbackBreachCount = 0;
    for (const lead of callbackBreaches) {
      if (await this.wasRecentlyEscalated(lead.id, 'CALLBACK_BREACH', COOLDOWNS.CALLBACK)) continue;

      this.logger.log(`[SLA] Lead ${lead.id} CALLBACK_WAIT breach — ${lead.name}`);

      const notif = await this.notifService.createNotification({
        user_id:         lead.assigned_to,
        type:            NotificationType.ACTION,
        priority:        NotificationPriority.HIGH,
        title:           '📞 Callback overdue — customer is waiting',
        message:         `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — ${lead.product_interest ?? 'General enquiry'} — promised callback time has passed.`,
        entity_type:     'lead',
        entity_id:       lead.id,
        cooldownMinutes: COOLDOWNS.CALLBACK,
        is_automated:    true,
      });

      if (notif) {
        await this.markEscalated(lead.id, 'CALLBACK_BREACH');
        callbackBreachCount++;
        await this.safeWaSendToUser(
          lead.assigned_to,
          `📞 *Callback Overdue*\n` +
          `Lead: ${lead.name}\n` +
          `Phone: ${lead.phone ?? 'N/A'}\n` +
          `Interest: ${lead.product_interest ?? 'General enquiry'}\n\n` +
          `You promised a callback that is now overdue. Call immediately.`,
        );
      }
    }

    // ── C. NO_ANSWER_ESC — collect for manager digest, no per-lead fan-out ────
    const escLeads: Array<{
      id: number; name: string; no_answer_count: number;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.no_answer_count
       FROM leads l
       WHERE l.workflow_state = 'NO_ANSWER_ESC'
         AND l.next_action_due_at < NOW()
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY l.no_answer_count DESC
       LIMIT 20`,
    );

    const escLeadsFiltered: typeof escLeads = [];
    for (const lead of escLeads) {
      if (!(await this.wasRecentlyEscalated(lead.id, 'NO_ANSWER_ESC', COOLDOWNS.NO_ANSWER_ESC))) {
        escLeadsFiltered.push(lead);
      }
    }
    for (const lead of escLeadsFiltered) {
      await this.markEscalated(lead.id, 'NO_ANSWER_ESC');
      this.logger.log(`[ESC] NO_ANSWER_ESC lead ${lead.id} — ${lead.no_answer_count} unanswered calls`);
    }

    // ── Manager digest — ONE notification per manager per cycle ───────────────
    const totalIssues = slaBreachCount + callbackBreachCount + escLeadsFiltered.length;
    if (totalIssues > 0) {
      const managers: Array<{ id: number }> = await this.ds.query(
        `SELECT id FROM "user" WHERE role IN ('Admin', 'COO', 'Sales Manager') AND is_active = true`,
      );

      const digestLines: string[] = [];
      if (slaBreachCount > 0)            digestLines.push(`• ${slaBreachCount} SLA breach${slaBreachCount > 1 ? 'es' : ''}`);
      if (callbackBreachCount > 0)       digestLines.push(`• ${callbackBreachCount} callback breach${callbackBreachCount > 1 ? 'es' : ''}`);
      if (escLeadsFiltered.length > 0)   digestLines.push(`• ${escLeadsFiltered.length} NO_ANSWER escalation${escLeadsFiltered.length > 1 ? 's' : ''}`);
      if (escLeadsFiltered.length > 0) {
        digestLines.push(
          ...escLeadsFiltered.slice(0, 3).map(l => `  – ${l.name} (${l.no_answer_count}× no answer)`),
        );
      }

      for (const manager of managers) {
        await this.notifService.createNotification({
          user_id:         manager.id,
          type:            NotificationType.REMINDER,
          priority:        NotificationPriority.MEDIUM,
          title:           `${totalIssues} lead${totalIssues > 1 ? 's' : ''} require attention`,
          message:         digestLines.join('\n'),
          entity_type:     'system',
          entity_id:       1,
          cooldownMinutes: 60, // one digest per manager per hour
          is_automated:    true,
        });
      }

      this.logger.log(
        `[DIGEST] manager=${managers.map(m => m.id).join(',')} ` +
        `summary={sla:${slaBreachCount}, callback:${callbackBreachCount}, esc:${escLeadsFiltered.length}}`,
      );
    }

    const rawTotal = leads.length + callbackBreaches.length + escLeads.length;
    if (rawTotal > 0) {
      this.logger.log(
        `remindOverdueFollowUps: ${slaBreachCount}/${leads.length} SLA breach notified, ` +
        `${callbackBreachCount}/${callbackBreaches.length} callback breach, ` +
        `${escLeadsFiltered.length}/${escLeads.length} NO_ANSWER_ESC`,
      );
    }
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
       WHERE l.workflow_state = 'FIRST_CALL'
         AND COALESCE(l.workflow_state_entered_at, l.created_at) < NOW() - INTERVAL '24 hours'
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY COALESCE(l.workflow_state_entered_at, l.created_at) ASC
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

  // ── 5. SEND_QUOTATION leads with no quotation sent after 24h ────────────────

  @Cron('0 */3 * * *')
  async nudgeQuotationPending(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    const leads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; workflow_state_entered_at: string;
    }> = await this.ds.query(
      `SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.workflow_state_entered_at
       FROM leads l
       WHERE l.workflow_state = 'SEND_QUOTATION'
         AND l.quotation_id IS NULL
         AND l.next_action_due_at < NOW() - INTERVAL '24 hours'
         AND COALESCE(l.workflow_state_entered_at, l.created_at) > NOW() - INTERVAL '7 days'
         AND l.is_active = true
         AND l.assigned_to IS NOT NULL
         AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
       ORDER BY l.next_action_due_at ASC
       LIMIT 30`,
    );

    if (!leads.length) return;

    // Also notify managers when a SEND_QUOTATION lead is badly stale (>24h breach)
    const managers: Array<{ id: number }> = await this.ds.query(`
      SELECT id FROM "user"
      WHERE role IN ('Admin', 'COO', 'Sales Manager')
        AND is_active = true
    `);

    let quotationNudgeCount = 0;
    for (const lead of leads) {
      // 12h cooldown per lead to prevent repeated quotation escalations
      if (await this.wasRecentlyEscalated(lead.id, 'QUOTATION_ESCALATION', 720)) continue;

      const hoursStale = Math.floor((Date.now() - new Date(lead.workflow_state_entered_at).getTime()) / 3_600_000);
      this.logger.log(`[SLA] Lead ${lead.id} SEND_QUOTATION ${hoursStale}h stale — no quotation sent`);

      const notif = await this.notifService.createNotification({
        user_id:        lead.assigned_to,
        type:           NotificationType.ACTION,
        priority:       NotificationPriority.HIGH,
        title:          'Quotation not sent — lead going cold',
        message:        `${lead.name} has been in SEND_QUOTATION for ${hoursStale}h but has no quotation. Send one now before they move on.`,
        entity_type:    'lead',
        entity_id:      lead.id,
        cooldownMinutes: 720,
        is_automated:    true,
      });

      if (notif) {
        await this.markEscalated(lead.id, 'QUOTATION_ESCALATION');
        quotationNudgeCount++;
        await this.safeWaSendToUser(
          lead.assigned_to,
          `🚨 *Quotation Not Sent — ${hoursStale}h Overdue*\n` +
          `Lead: ${lead.name}\n` +
          `Interest: ${lead.product_interest ?? 'General enquiry'}\n\n` +
          `This lead has been waiting for a quotation for ${hoursStale} hours. ` +
          `Send it now — leads that wait >24h rarely convert.`,
        );
      }
    }

    // Manager digest for quotation breaches — one per manager, not one per lead
    if (quotationNudgeCount > 0) {
      const digestMsg = leads
        .slice(0, 5)
        .map(l => `• ${l.name} (${Math.floor((Date.now() - new Date(l.workflow_state_entered_at).getTime()) / 3_600_000)}h)`)
        .join('\n');
      for (const manager of managers) {
        await this.notifService.createNotification({
          user_id:        manager.id,
          type:           NotificationType.ACTION,
          priority:       NotificationPriority.HIGH,
          title:          `${quotationNudgeCount} quotation breach${quotationNudgeCount > 1 ? 'es' : ''} — no quotes sent`,
          message:        digestMsg,
          entity_type:    'system',
          entity_id:      2,
          cooldownMinutes: 720,
          is_automated:    true,
        });
      }
      this.logger.log(`[DIGEST] quotation breach: ${quotationNudgeCount} lead(s) flagged to ${managers.length} manager(s)`);
    }

    this.logger.log(`[SLA] nudgeQuotationPending: ${quotationNudgeCount}/${leads.length} SEND_QUOTATION lead(s) nudged`);
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
      // Only auto-resume leads where automation was snoozed (automation_manually_paused = false).
      // Leads paused manually by a manager (automation_manually_paused = true) are not touched —
      // their automation_off tag survives snooze expiry and must be cleared by the manager.
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
         AND (automation_manually_paused = false OR automation_manually_paused IS NULL)
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

  // ── 13. Stagnation detection (every 2 hours) ──────────────────────────────────
  // Detects leads with no real CALL activity within SLA×2 threshold per workflow_state.
  // Tags `stale_lead`, notifies assigned user (2h cooldown).
  // After 24h still stale: manager digest (entity_id=3, 6h cooldown) + esc_manager_notified tag.

  @Cron('0 */2 * * *')
  async detectStagnantLeads(): Promise<void> {
    if (!await this.isSetting('automation.followup_reminders')) return;

    // Leads with no CALLED audit entry within per-state SLA×2 window, not yet tagged stale
    const staleLeads: Array<{
      id: number; name: string; phone: string; product_interest: string;
      assigned_to: number; workflow_state: string;
    }> = await this.ds.query(`
      SELECT l.id, l.name, l.phone, l.product_interest, l.assigned_to, l.workflow_state
      FROM leads l
      WHERE l.workflow_state NOT IN ('CONVERTED', 'LOST', 'NURTURE', 'CALLBACK_WAIT')
        AND l.is_active = true
        AND l.assigned_to IS NOT NULL
        AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'automation_off')
        AND NOT (COALESCE(l.tags, '[]'::jsonb) ? 'stale_lead')
        AND NOT EXISTS (
          SELECT 1 FROM lead_audit_logs lal
          WHERE lal.lead_id = l.id
            AND lal.action = 'CALLED'
            AND lal.created_at > NOW() - CASE l.workflow_state
              WHEN 'FIRST_CALL'      THEN INTERVAL '4 hours'
              WHEN 'SEND_QUOTATION'  THEN INTERVAL '4 hours'
              WHEN 'FOLLOW_UP'       THEN INTERVAL '48 hours'
              WHEN 'NO_ANSWER_1'     THEN INTERVAL '48 hours'
              WHEN 'NO_ANSWER_2'     THEN INTERVAL '48 hours'
              WHEN 'NO_ANSWER_ESC'   THEN INTERVAL '48 hours'
              WHEN 'CHASE_QUOTATION' THEN INTERVAL '144 hours'
              WHEN 'NEGOTIATING'     THEN INTERVAL '96 hours'
              ELSE INTERVAL '48 hours'
            END
        )
      ORDER BY l.next_action_due_at ASC NULLS LAST
      LIMIT 50
    `);

    let staleCount = 0;
    for (const lead of staleLeads) {
      if (await this.wasRecentlyEscalated(lead.id, 'STALE_LEAD', 120)) continue;

      this.logger.log(`[STALE] Lead ${lead.id} stagnant — no CALL in SLA×2 window [${lead.workflow_state}]`);

      const notif = await this.notifService.createNotification({
        user_id:         lead.assigned_to,
        type:            NotificationType.ACTION,
        priority:        NotificationPriority.MEDIUM,
        title:           'Lead stagnating — no call logged',
        message:         `${lead.name}${lead.phone ? ` · ${lead.phone}` : ''} — ${lead.product_interest ?? 'General enquiry'} [${lead.workflow_state}] has had no call logged in the expected window.`,
        entity_type:     'lead',
        entity_id:       lead.id,
        cooldownMinutes: 120,
        is_automated:    true,
      });

      if (notif) {
        await this.markEscalated(lead.id, 'STALE_LEAD');
        await this.addEscTagIfMissing(lead.id, 'stale_lead');
        staleCount++;
      }
    }

    // Manager digest: leads already tagged stale_lead with no call in 24h, not yet escalated to manager
    const longStale: Array<{ id: number; name: string; workflow_state: string }> = await this.ds.query(`
      SELECT l.id, l.name, l.workflow_state
      FROM leads l
      WHERE l.workflow_state NOT IN ('CONVERTED', 'LOST', 'NURTURE', 'CALLBACK_WAIT')
        AND l.is_active = true
        AND (COALESCE(l.tags, '[]'::jsonb) @> '["stale_lead"]')
        AND NOT (COALESCE(l.tags, '[]'::jsonb) @> '["esc_manager_notified"]')
        AND NOT EXISTS (
          SELECT 1 FROM lead_audit_logs lal
          WHERE lal.lead_id = l.id
            AND lal.action = 'CALLED'
            AND lal.created_at > NOW() - INTERVAL '24 hours'
        )
      LIMIT 20
    `);

    const longStaleFiltered: typeof longStale = [];
    for (const lead of longStale) {
      if (!(await this.wasRecentlyEscalated(lead.id, 'STALE_MANAGER', 360))) {
        longStaleFiltered.push(lead);
      }
    }

    if (longStaleFiltered.length > 0) {
      const managers: Array<{ id: number }> = await this.ds.query(
        `SELECT id FROM "user" WHERE role IN ('Admin', 'COO', 'Sales Manager') AND is_active = true`,
      );
      const digestLines = longStaleFiltered.slice(0, 5).map(l => `• ${l.name} [${l.workflow_state}]`);

      for (const manager of managers) {
        await this.notifService.createNotification({
          user_id:         manager.id,
          type:            NotificationType.ACTION,
          priority:        NotificationPriority.HIGH,
          title:           `${longStaleFiltered.length} lead${longStaleFiltered.length > 1 ? 's' : ''} stagnant 24h+ — no calls`,
          message:         digestLines.join('\n'),
          entity_type:     'system',
          entity_id:       3,
          cooldownMinutes: 360,
          is_automated:    true,
        });
      }

      for (const lead of longStaleFiltered) {
        await this.markEscalated(lead.id, 'STALE_MANAGER');
        await this.addEscTagIfMissing(lead.id, 'esc_manager_notified');
      }
      this.logger.log(`[STALE] ${longStaleFiltered.length} long-stale lead(s) escalated to ${managers.length} manager(s)`);
    }

    if (staleCount > 0 || longStaleFiltered.length > 0) {
      this.logger.log(`detectStagnantLeads: ${staleCount} new stale, ${longStaleFiltered.length} long-stale escalated`);
    }
    await this.recordLastRun('cron.stagnation_detection.last_run');
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async safeWaSendToUser(userId: number, message: string): Promise<void> {
    if (this.isWaBlocked(userId)) {
      this.logger.debug(`[WA_SUPPRESS] user=${userId} blocked — skipping WA send`);
      return;
    }
    try {
      await this.waService.sendToAssignee(userId, message);
    } catch (e: any) {
      this.recordWaFailure(userId);
      this.logger.warn(`[WA_SUPPRESS] user=${userId} WA send failed: ${e?.message}`);
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
        WHERE workflow_state NOT IN ('CONVERTED', 'LOST', 'NURTURE', 'NEGOTIATING')
          AND is_active = true
          AND assigned_to IS NOT NULL
          AND next_action_due_at < NOW() - INTERVAL '72 hours'
          AND (lead_quality IS NULL OR lead_quality NOT IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE'))
          AND NOT (COALESCE(tags, '[]'::jsonb) ? 'automation_off')
          AND NOT (COALESCE(tags, '[]'::jsonb) ? 'assignment_locked')
          -- SEND_QUOTATION with a quotation linked is actively progressing — do not reassign
          AND NOT (workflow_state = 'SEND_QUOTATION' AND quotation_id IS NOT NULL)
          -- Skip if already auto-reassigned within the last 72h (audit trail check)
          AND NOT EXISTS (
            SELECT 1 FROM lead_audit_logs lal
            WHERE lal.lead_id = leads.id
              AND lal.action = 'ESCALATED'
              AND lal.detail LIKE '%AUTO_REASSIGN%'
              AND lal.created_at > NOW() - INTERVAL '72 hours'
          )
        ORDER BY next_action_due_at ASC
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
               updated_at  = NOW()
           WHERE id = $2`,
          [newAssigneeId, lead.id],
        );

        // Persist reassign in audit trail so the 72h guard works next cycle
        await this.markEscalated(lead.id, 'AUTO_REASSIGN');
        this.logger.log(`[REASSIGN] Lead ${lead.id} reassigned from user=${oldAssigneeId} to user=${newAssigneeId}`);

        await this.notifService.createNotification({
          user_id:         oldAssigneeId,
          type:            NotificationType.INFO,
          priority:        NotificationPriority.LOW,
          title:           'Lead auto-reassigned',
          message:         `${lead.name} was reassigned after 72h of no activity.`,
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
          `Previous salesman had no activity for 72+ hours. Please follow up immediately.`,
        );
      } catch (e: any) {
        this.logger.warn(`[REASSIGN] autoReassignStaleLeads failed for lead ${lead.id}: ${e?.message}`);
      }
    }

    this.logger.log(`[REASSIGN] autoReassignStaleLeads: processed ${stale.length} stale lead(s)`);
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

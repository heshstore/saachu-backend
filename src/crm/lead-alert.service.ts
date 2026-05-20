import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { LeadAlert } from './entities/lead-alert.entity';
import { DbHealthService } from '../shared/db-health.service';

@Injectable()
export class LeadAlertService {
  private readonly logger = new Logger(LeadAlertService.name);
  private _running = false;

  constructor(
    @InjectRepository(LeadAlert)
    private alertRepo: Repository<LeadAlert>,
    @InjectDataSource()
    private ds: DataSource,
    private readonly dbHealth: DbHealthService,
  ) {}

  // ── Public query API ─────────────────────────────────────────────────────────

  async getAlertsForLead(leadId: number): Promise<LeadAlert[]> {
    return this.alertRepo.find({
      where: { lead_id: leadId, resolved: false },
      order: { created_at: 'DESC' },
    });
  }

  async resolveAlert(alertId: number): Promise<void> {
    await this.alertRepo.update({ id: alertId }, { resolved: true });
  }

  async resolveAllForLead(leadId: number): Promise<void> {
    await this.alertRepo.update({ lead_id: leadId, resolved: false }, { resolved: true });
  }

  // ── Cron: runs every 15 minutes ──────────────────────────────────────────────

  @Cron('*/15 * * * *')
  async runAlertChecks(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      // Run all three checks in parallel — independent queries, no shared state
      const results = await Promise.allSettled([
        this.alertNotContacted(),
        this.alertHighPriorityStale(),
        this.alertOverdueFollowUps(),
      ]);

      for (const r of results) {
        if (r.status === 'rejected') {
          this.logger.error(`Alert check failed: ${r.reason?.message}`, r.reason?.stack);
        }
      }
    } catch (e: any) {
      this.dbHealth.handleError(e, 'LeadAlertService.runAlertChecks');
    } finally {
      this._running = false;
    }
  }

  // ── Condition: NEW lead not contacted within 24 h ────────────────────────────

  private async alertNotContacted(): Promise<void> {
    // Batch insert — NOT EXISTS handles dedup so we never create a duplicate
    // unresolved NOT_CONTACTED alert for the same lead
    const result = await this.ds.query(`
      INSERT INTO lead_alerts (lead_id, type, message)
      SELECT
        l.id,
        'NOT_CONTACTED',
        'Lead "' || l.name || '" has been NEW for over 24 hours without contact'
      FROM leads l
      WHERE l.status = 'NEW'
        AND l.is_active = true
        AND l.assigned_to IS NOT NULL
        AND l.created_at <= now() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM lead_alerts a
          WHERE a.lead_id = l.id AND a.type = 'NOT_CONTACTED' AND a.resolved = false
        )
    `);
    const count = result?.rowCount ?? 0;
    if (count > 0) this.logger.warn(`AlertEngine: created ${count} NOT_CONTACTED alert(s)`);
  }

  // ── Condition: HIGH priority lead not updated within 12 h ───────────────────

  private async alertHighPriorityStale(): Promise<void> {
    const result = await this.ds.query(`
      INSERT INTO lead_alerts (lead_id, type, message)
      SELECT
        l.id,
        'HIGH_PRIORITY_STALE',
        'High priority lead "' || l.name || '" has not been updated in over 12 hours'
      FROM leads l
      WHERE l.lead_priority = 'HIGH'
        AND l.is_active = true
        AND l.status NOT IN ('CONVERTED', 'LOST')
        AND l.updated_at <= now() - INTERVAL '12 hours'
        AND NOT EXISTS (
          SELECT 1 FROM lead_alerts a
          WHERE a.lead_id = l.id AND a.type = 'HIGH_PRIORITY_STALE' AND a.resolved = false
        )
    `);
    const count = result?.rowCount ?? 0;
    if (count > 0) this.logger.warn(`AlertEngine: created ${count} HIGH_PRIORITY_STALE alert(s)`);
  }

  // ── System alerts (not tied to a specific lead) ──────────────────────────────

  /**
   * Creates a WHATSAPP_DOWN alert only if no unresolved one exists already.
   * Deduplication is done in SQL to be race-safe.
   */
  async createWhatsAppDownAlert(reason: string): Promise<void> {
    await this.ds.query(`
      INSERT INTO lead_alerts (lead_id, type, message)
      SELECT NULL, 'WHATSAPP_DOWN', $1
      WHERE NOT EXISTS (
        SELECT 1 FROM lead_alerts
        WHERE type = 'WHATSAPP_DOWN' AND resolved = false
      )
    `, [`WhatsApp disconnected: ${reason}`]);
    this.logger.warn(`[AlertEngine] WHATSAPP_DOWN alert created (reason=${reason})`);
  }

  /** Resolves all open WHATSAPP_DOWN alerts (called when WhatsApp reconnects). */
  async resolveWhatsAppAlerts(): Promise<void> {
    const result = await this.alertRepo.update(
      { type: 'WHATSAPP_DOWN' as any, resolved: false },
      { resolved: true },
    );
    if ((result.affected ?? 0) > 0) {
      this.logger.log(`[AlertEngine] Resolved ${result.affected} WHATSAPP_DOWN alert(s)`);
    }
  }

  // ── WhatsApp event listeners ──────────────────────────────────────────────────

  @OnEvent('whatsapp.down')
  async onWhatsAppDown(payload: { reason: string }): Promise<void> {
    try {
      await this.createWhatsAppDownAlert(payload.reason ?? 'unknown');
    } catch (e: any) {
      this.logger.error(`[AlertEngine] Failed to create WHATSAPP_DOWN alert: ${e?.message}`);
    }
  }

  @OnEvent('whatsapp.up')
  async onWhatsAppUp(): Promise<void> {
    try {
      await this.resolveWhatsAppAlerts();
    } catch (e: any) {
      this.logger.error(`[AlertEngine] Failed to resolve WHATSAPP_DOWN alerts: ${e?.message}`);
    }
  }

  // ── Condition: follow-up past due date ───────────────────────────────────────

  private async alertOverdueFollowUps(): Promise<void> {
    const result = await this.ds.query(`
      INSERT INTO lead_alerts (lead_id, type, message)
      SELECT
        l.id,
        'FOLLOWUP_OVERDUE',
        'Follow-up for lead "' || l.name || '" is overdue (was due ' ||
          to_char(f.due_date AT TIME ZONE 'UTC', 'DD-Mon HH24:MI') || ' UTC)'
      FROM lead_followups f
      JOIN leads l ON l.id = f.lead_id
      WHERE f.is_completed = false
        AND f.due_date < now()
        AND l.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM lead_alerts a
          WHERE a.lead_id = l.id AND a.type = 'FOLLOWUP_OVERDUE' AND a.resolved = false
        )
    `);
    const count = result?.rowCount ?? 0;
    if (count > 0) this.logger.warn(`AlertEngine: created ${count} FOLLOWUP_OVERDUE alert(s)`);
  }
}

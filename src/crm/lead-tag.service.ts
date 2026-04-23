import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';

/**
 * Computes behavioral tags for all active leads in a single batch SQL UPDATE.
 * No N+1 — LATERAL subqueries gather per-lead metrics inline.
 *
 * Tags:
 *   high_intent   — 3 or more follow-ups scheduled
 *   slow_response — first note arrived 4+ hours after lead creation (or no note yet after 4h)
 *   bulk_buyer    — requirement text contains bulk/quantity keywords
 */
@Injectable()
export class LeadTagService {
  private readonly logger = new Logger(LeadTagService.name);

  constructor(@InjectDataSource() private ds: DataSource) {}

  @Cron('0 2 * * *') // daily at 02:00 server time — low-traffic window
  async computeTags(): Promise<void> {
    this.logger.log('[Cron] LeadTagService: computing tags...');
    try {
      await this._computeTagsInner();
    } catch (e: any) {
      this.logger.error('[Cron] LeadTagService: tag computation failed', e?.stack ?? e?.message);
      // Do NOT rethrow — a single failure must never prevent the next scheduled run
    }
  }

  private async _computeTagsInner(): Promise<void> {
    const result = await this.ds.query(`
      UPDATE leads SET tags = computed.tags
      FROM (
        SELECT
          l.id,
          (
            CASE WHEN fu_stats.fu_count >= 3 THEN '["high_intent"]'::jsonb ELSE '[]'::jsonb END
            ||
            CASE WHEN COALESCE(note_stats.delay_hours, 999) >= 4 THEN '["slow_response"]'::jsonb ELSE '[]'::jsonb END
            ||
            CASE
              WHEN (
                COALESCE(l.notes, '') || ' ' ||
                COALESCE(l.notes, '') || ' ' ||
                COALESCE(l.product_interest, '')
              ) ~* '\\y(bulk|wholesale|container|tonnes?|tons?|\\d{3,}\\s*(kg|pcs|units?|boxes?|cartons?))\\y'
              THEN '["bulk_buyer"]'::jsonb ELSE '[]'::jsonb END
          ) AS tags
        FROM leads l

        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS fu_count
          FROM lead_followups f
          WHERE f.lead_id = l.id
        ) fu_stats ON true

        LEFT JOIN LATERAL (
          SELECT EXTRACT(EPOCH FROM (MIN(n.created_at) - l.created_at)) / 3600 AS delay_hours
          FROM lead_notes n
          WHERE n.lead_id = l.id
        ) note_stats ON true

        WHERE l.is_active = true
      ) computed
      WHERE leads.id = computed.id
    `);

    this.logger.log(`LeadTagService: tagged ${result?.rowCount ?? 0} leads`);
  }

  /** On-demand recompute for a single lead (e.g. after conversion). */
  async computeForLead(leadId: number): Promise<void> {
    await this.ds.query(`
      UPDATE leads SET tags = computed.tags
      FROM (
        SELECT
          l.id,
          (
            CASE WHEN fu_stats.fu_count >= 3 THEN '["high_intent"]'::jsonb ELSE '[]'::jsonb END
            ||
            CASE WHEN COALESCE(note_stats.delay_hours, 999) >= 4 THEN '["slow_response"]'::jsonb ELSE '[]'::jsonb END
            ||
            CASE
              WHEN (
                COALESCE(l.notes, '') || ' ' ||
                COALESCE(l.notes, '') || ' ' ||
                COALESCE(l.product_interest, '')
              ) ~* '\\y(bulk|wholesale|container|tonnes?|tons?|\\d{3,}\\s*(kg|pcs|units?|boxes?|cartons?))\\y'
              THEN '["bulk_buyer"]'::jsonb ELSE '[]'::jsonb END
          ) AS tags
        FROM leads l
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS fu_count FROM lead_followups f WHERE f.lead_id = l.id
        ) fu_stats ON true
        LEFT JOIN LATERAL (
          SELECT EXTRACT(EPOCH FROM (MIN(n.created_at) - l.created_at)) / 3600 AS delay_hours
          FROM lead_notes n WHERE n.lead_id = l.id
        ) note_stats ON true
        WHERE l.id = $1
      ) computed
      WHERE leads.id = computed.id
    `, [leadId]);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CRM_FULL_ACCESS_ROLES, CRM_OPERATIONAL_QUALITY_SQL } from './crm.constants';

@Injectable()
export class AnalyticsService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  private isFullAccess(user: any) {
    return (CRM_FULL_ACCESS_ROLES as readonly string[]).includes(user?.role);
  }

  async getOverview(user: any) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const selectClause = `
      SELECT
        COUNT(*) FILTER (WHERE true) AS total,
        COUNT(*) FILTER (WHERE l.status = 'NEW') AS new_count,
        COUNT(*) FILTER (WHERE l.status = 'CONTACTED') AS contacted,
        COUNT(*) FILTER (WHERE l.status = 'INTERESTED') AS interested,
        COUNT(*) FILTER (WHERE l.status = 'QUOTATION') AS quotation,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED') AS converted,
        COUNT(*) FILTER (WHERE l.status = 'LOST') AS lost,
        COUNT(*) FILTER (WHERE l.created_at >= $1) AS today_new
      FROM leads l
    `;

    let rows: any[];
    if (this.isFullAccess(user)) {
      rows = await this.ds.query(`${selectClause} WHERE l.is_active = true`, [today]);
    } else {
      rows = await this.ds.query(
        `${selectClause} WHERE l.is_active = true AND (l.assigned_to = $2 OR l.created_by = $2)`,
        [today, user.id],
      );
    }

    const r = rows[0];
    return {
      total: +r.total,
      byStatus: {
        new: +r.new_count,
        contacted: +r.contacted,
        interested: +r.interested,
        quotation: +r.quotation,
        converted: +r.converted,
        lost: +r.lost,
      },
      todayNew: +r.today_new,
    };
  }

  async getSourceBreakdown(user: any) {
    const selectClause = `
      SELECT
        l.source,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE l.status IN ('QUOTATION','CONVERTED')) AS to_quotation,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
      FROM leads l
    `;
    const tail = `GROUP BY l.source ORDER BY total DESC`;

    let rows: any[];
    if (this.isFullAccess(user)) {
      rows = await this.ds.query(`${selectClause} WHERE l.is_active = true ${tail}`);
    } else {
      rows = await this.ds.query(
        `${selectClause} WHERE l.is_active = true AND (l.assigned_to = $1 OR l.created_by = $1) ${tail}`,
        [user.id],
      );
    }

    return rows.map((r: any) => ({
      source: r.source,
      total: +r.total,
      toQuotation: +r.to_quotation,
      converted: +r.converted,
      conversionPct: r.total > 0 ? Math.round((r.converted / r.total) * 100) : 0,
    }));
  }

  async getMyStats(user: any) {
    const rows = await this.ds.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED') AS converted,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED' AND l.updated_at::date = CURRENT_DATE) AS converted_today,
        COUNT(*) FILTER (WHERE l.status = 'LOST') AS lost,
        COUNT(*) FILTER (WHERE l.follow_up_date::date = CURRENT_DATE) AS due_today
      FROM leads l
      WHERE l.is_active = true
        AND (l.assigned_to = $1 OR l.created_by = $1)
    `, [user.id]);

    const pendingFu = await this.ds.query(`
      SELECT COUNT(*) AS cnt
      FROM lead_followups f
      JOIN leads l ON l.id = f.lead_id
      WHERE f.is_completed = false
        AND f.due_date <= now() + INTERVAL '24 hours'
        AND l.assigned_to = $1
    `, [user.id]);

    const r = rows[0];
    return {
      total: +r.total,
      converted: +r.converted,
      convertedToday: +r.converted_today,
      lost: +r.lost,
      dueToday: +r.due_today,
      overdueFollowUps: +pendingFu[0].cnt,
    };
  }

  async getLeaderboard(user: any) {
    // No revenue — only activity metrics
    const rows = await this.ds.query(`
      SELECT
        u.id,
        u.name,
        COUNT(l.id) AS total_leads,
        COUNT(l.id) FILTER (WHERE l.status = 'CONVERTED') AS converted,
        COUNT(l.id) FILTER (WHERE l.status = 'CONTACTED' OR l.status != 'NEW') AS contacted,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (
            (SELECT MIN(n.created_at) FROM lead_notes n WHERE n.lead_id = l.id)
            - l.created_at
          )) / 60
        )::numeric, 1) AS avg_response_min
      FROM "user" u
      LEFT JOIN leads l ON l.assigned_to = u.id AND l.is_active = true
      WHERE u.is_active = true
        AND u.role IN ('Tele calling Executive','Territory Manager','Field Executive')
      GROUP BY u.id, u.name
      ORDER BY converted DESC, total_leads DESC
    `);

    return rows.map((r: any) => ({
      userId: r.id,
      name: r.name,
      totalLeads: +r.total_leads,
      converted: +r.converted,
      contacted: +r.contacted,
      avgResponseMin: r.avg_response_min ? +r.avg_response_min : null,
    }));
  }

  /**
   * Detailed performance metrics for a single user.
   * Uses 4 targeted queries — no N+1, no correlated subqueries on hot paths.
   * Permission check: full-access roles can query anyone; others can only query themselves.
   */
  async getPerformance(targetUserId: number, user: any) {
    const fullAccess = this.isFullAccess(user);
    if (!fullAccess && user.id !== targetUserId) {
      targetUserId = user.id; // silently scope to self — permission guard already runs
    }

    // 1. Lead totals
    const [leadsRow] = await this.ds.query(`
      SELECT
        COUNT(*) AS total_leads,
        COUNT(*) FILTER (WHERE status = 'CONVERTED') AS conversions,
        COUNT(*) FILTER (WHERE status = 'LOST') AS lost
      FROM leads
      WHERE (assigned_to = $1 OR created_by = $1) AND is_active = true
    `, [targetUserId]);

    // 2. CALLED actions from audit log (only counts logged calls via logAction)
    const [callsRow] = await this.ds.query(`
      SELECT COUNT(*) AS calls_made
      FROM lead_audit_logs
      WHERE user_id = $1 AND action = 'CALLED'
    `, [targetUserId]);

    // 3. Follow-up completion rate across their assigned leads
    const [fuRow] = await this.ds.query(`
      SELECT
        COUNT(*) FILTER (WHERE f.is_completed = true) AS fu_completed,
        COUNT(*) AS fu_total
      FROM lead_followups f
      JOIN leads l ON l.id = f.lead_id
      WHERE l.assigned_to = $1 AND l.is_active = true
    `, [targetUserId]);

    // 4. Avg first-response time (minutes from lead creation to first note)
    const [responseRow] = await this.ds.query(`
      SELECT ROUND(AVG(response_min)::numeric, 1) AS avg_response_min
      FROM (
        SELECT EXTRACT(EPOCH FROM (MIN(n.created_at) - l.created_at)) / 60 AS response_min
        FROM leads l
        JOIN lead_notes n ON n.lead_id = l.id
        WHERE l.assigned_to = $1 AND l.is_active = true
        GROUP BY l.id
      ) sub
    `, [targetUserId]);

    const fuTotal = +fuRow.fu_total;
    return {
      userId: targetUserId,
      totalLeads: +leadsRow.total_leads,
      conversions: +leadsRow.conversions,
      lost: +leadsRow.lost,
      callsMade: +callsRow.calls_made,
      followUpCompletionPct: fuTotal > 0
        ? Math.round((+fuRow.fu_completed / fuTotal) * 100)
        : null,
      avgResponseMin: responseRow.avg_response_min
        ? +responseRow.avg_response_min
        : null,
    };
  }

  /**
   * Leads grouped by context ("META – Lead Form", "SHOPIFY – WhatsApp Click", etc.).
   * Null/empty context rows are consolidated into "Unknown".
   * Full-access roles see the whole org; others see only their own leads.
   */
  async getContextBreakdown(user: any) {
    const selectClause = `
      SELECT
        COALESCE(NULLIF(l.context, ''), 'Unknown') AS context,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE l.status IN ('QUOTATION','CONVERTED')) AS to_quotation,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
      FROM leads l
    `;
    const tail = `GROUP BY 1 ORDER BY total DESC`;

    let rows: any[];
    if (this.isFullAccess(user)) {
      rows = await this.ds.query(`${selectClause} WHERE l.is_active = true ${tail}`);
    } else {
      rows = await this.ds.query(
        `${selectClause} WHERE l.is_active = true AND (l.assigned_to = $1 OR l.created_by = $1) ${tail}`,
        [user.id],
      );
    }

    return rows.map((r: any) => ({
      context: r.context,
      total: +r.total,
      toQuotation: +r.to_quotation,
      converted: +r.converted,
      conversionPct: r.total > 0 ? Math.round((r.converted / r.total) * 100) : 0,
    }));
  }

  /**
   * Leads created per day for the last N days (default 30).
   * Returns an array sorted by date ASC for easy charting.
   */
  async getDateBreakdown(days: number, user: any) {
    const safeDays = Math.min(Math.max(days || 30, 1), 365);
    const selectClause = `
      SELECT
        l.created_at::date AS day,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
      FROM leads l
    `;
    const tail = `
      AND l.created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY 1 ORDER BY 1 ASC
    `;

    let rows: any[];
    if (this.isFullAccess(user)) {
      rows = await this.ds.query(
        `${selectClause} WHERE l.is_active = true ${tail}`,
        [String(safeDays)],
      );
    } else {
      rows = await this.ds.query(
        `${selectClause} WHERE l.is_active = true AND (l.assigned_to = $2 OR l.created_by = $2) ${tail}`,
        [String(safeDays), user.id],
      );
    }

    return rows.map((r: any) => ({
      date: r.day,
      total: +r.total,
      converted: +r.converted,
    }));
  }

  async getTelecallerStats(telecallerId: number, user: any) {
    const rows = await this.ds.query(`
      SELECT
        l.status,
        l.source,
        COUNT(*) AS cnt
      FROM leads l
      WHERE l.assigned_to = $1 AND l.is_active = true
      GROUP BY l.status, l.source
    `, [telecallerId]);

    const user_row = await this.ds.query(
      `SELECT id, name FROM "user" WHERE id = $1`,
      [telecallerId],
    );

    return {
      telecaller: user_row[0] ?? null,
      breakdown: rows,
    };
  }

  async getResponseSpeed(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE is_active = true`
      : `WHERE is_active = true AND (assigned_to = $1 OR created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    const [r] = await this.ds.query(`
      SELECT
        COUNT(*) FILTER (WHERE last_customer_reply_at IS NOT NULL) AS total_with_reply,
        COUNT(*) FILTER (
          WHERE last_salesman_reply_at >= last_customer_reply_at
            AND EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60 <= 30
        ) AS within_30min,
        COUNT(*) FILTER (
          WHERE last_salesman_reply_at >= last_customer_reply_at
            AND EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60 <= 120
        ) AS within_2h,
        ROUND(AVG(
          CASE WHEN last_salesman_reply_at >= last_customer_reply_at
            THEN EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60
          END
        )::numeric, 1) AS avg_reply_min,
        COUNT(*) FILTER (
          WHERE last_customer_reply_at IS NOT NULL
            AND status NOT IN ('CONVERTED', 'LOST')
            AND (last_salesman_reply_at IS NULL OR last_salesman_reply_at < last_customer_reply_at)
        ) AS currently_unanswered
      FROM leads l
      ${where}
    `, params);

    const totalWithReply = +r.total_with_reply;
    return {
      totalWithReply,
      within30MinCount: +r.within_30min,
      within2hCount: +r.within_2h,
      within30MinPct: totalWithReply > 0 ? Math.round((+r.within_30min / totalWithReply) * 100) : null,
      within2hPct: totalWithReply > 0 ? Math.round((+r.within_2h / totalWithReply) * 100) : null,
      avgReplyMin: r.avg_reply_min ? +r.avg_reply_min : null,
      currentlyUnanswered: +r.currently_unanswered,
    };
  }

  async getFunnel(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE is_active = true`
      : `WHERE is_active = true AND (assigned_to = $1 OR created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    const [r] = await this.ds.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('CONTACTED','INTERESTED','QUOTATION','CONVERTED')) AS contacted,
        COUNT(*) FILTER (WHERE status IN ('INTERESTED','QUOTATION','CONVERTED')) AS interested,
        COUNT(*) FILTER (WHERE status IN ('QUOTATION','CONVERTED')) AS quotation,
        COUNT(*) FILTER (WHERE status = 'CONVERTED') AS converted,
        COUNT(*) FILTER (WHERE status = 'LOST') AS lost
      FROM leads l
      ${where}
    `, params);

    const total = +r.total || 1;
    return {
      total: +r.total,
      contacted: +r.contacted,
      interested: +r.interested,
      quotation: +r.quotation,
      converted: +r.converted,
      lost: +r.lost,
      rates: {
        contactedPct: Math.round((+r.contacted / total) * 100),
        interestedPct: Math.round((+r.interested / total) * 100),
        quotationPct: Math.round((+r.quotation / total) * 100),
        convertedPct: Math.round((+r.converted / total) * 100),
      },
    };
  }

  async getRiskSignals(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE is_active = true`
      : `WHERE is_active = true AND (assigned_to = $1 OR created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    const [r] = await this.ds.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE last_customer_reply_at IS NOT NULL
            AND status NOT IN ('CONVERTED', 'LOST')
            AND (last_salesman_reply_at IS NULL OR last_salesman_reply_at < last_customer_reply_at)
            AND EXTRACT(EPOCH FROM (NOW() - last_customer_reply_at)) / 60 >= 240
        ) AS overdue_count,
        COUNT(*) FILTER (
          WHERE last_customer_reply_at IS NOT NULL
            AND status NOT IN ('CONVERTED', 'LOST')
            AND (last_salesman_reply_at IS NULL OR last_salesman_reply_at < last_customer_reply_at)
            AND EXTRACT(EPOCH FROM (NOW() - last_customer_reply_at)) / 60 >= 120
            AND EXTRACT(EPOCH FROM (NOW() - last_customer_reply_at)) / 60 < 240
        ) AS waiting_critical_count,
        COUNT(*) FILTER (
          WHERE status = 'NEW'
            AND created_at < NOW() - INTERVAL '3 days'
        ) AS stale_new_count,
        COUNT(*) FILTER (
          WHERE status = 'INTERESTED'
            AND updated_at < NOW() - INTERVAL '7 days'
        ) AS stale_interested_count
      FROM leads l
      ${where}
    `, params);

    return {
      overdueCount: +r.overdue_count,
      waitingCriticalCount: +r.waiting_critical_count,
      staleNewCount: +r.stale_new_count,
      staleInterestedCount: +r.stale_interested_count,
    };
  }

  async getSourceROI(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE l.is_active = true AND l.status = 'CONVERTED' AND l.customer_id IS NOT NULL`
      : `WHERE l.is_active = true AND l.status = 'CONVERTED' AND l.customer_id IS NOT NULL
         AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    // ROI per source: for leads that converted, sum order values via customer_id join.
    // Note: if the same customer has multiple converted leads, order values may appear
    // across multiple source rows — this is intentional for channel attribution.
    const rows = await this.ds.query(`
      SELECT
        l.source,
        COUNT(DISTINCT l.id) AS converted_leads,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(o.total_amount), 0) AS total_order_value,
        COALESCE(SUM(o.total_amount - COALESCE(o.pending_amount, 0)), 0) AS total_paid,
        COALESCE(AVG(o.total_amount), 0) AS avg_order_value
      FROM leads l
      LEFT JOIN orders o ON o.customer_id = l.customer_id
        AND o.status NOT IN ('CANCELLED')
      ${where}
      GROUP BY l.source
      ORDER BY total_order_value DESC, converted_leads DESC
    `, params);

    // Also get total lead count per source (all statuses, not just CONVERTED)
    const allWhere = this.isFullAccess(user)
      ? `WHERE l.is_active = true`
      : `WHERE l.is_active = true AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const totalRows = await this.ds.query(`
      SELECT source, COUNT(*) AS total_leads
      FROM leads l
      ${allWhere}
      GROUP BY source
    `, params);

    const totalMap: Record<string, number> = {};
    for (const r of totalRows) totalMap[r.source] = +r.total_leads;

    return rows.map((r: any) => ({
      source:          r.source,
      totalLeads:      totalMap[r.source] ?? 0,
      convertedLeads:  +r.converted_leads,
      conversionPct:   (totalMap[r.source] ?? 0) > 0
        ? Math.round((+r.converted_leads / totalMap[r.source]) * 100)
        : 0,
      orderCount:      +r.order_count,
      totalOrderValue: Math.round(+r.total_order_value),
      totalPaid:       Math.round(+r.total_paid),
      avgOrderValue:   +r.avg_order_value ? Math.round(+r.avg_order_value) : 0,
    }));
  }

  async getResponseBuckets(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE last_customer_reply_at IS NOT NULL AND is_active = true`
      : `WHERE last_customer_reply_at IS NOT NULL AND is_active = true AND (assigned_to = $1 OR created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    const rows = await this.ds.query(`
      SELECT
        CASE
          WHEN last_salesman_reply_at IS NULL OR last_salesman_reply_at < last_customer_reply_at THEN 'unanswered'
          WHEN EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60 < 30  THEN 'under_30min'
          WHEN EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60 < 120 THEN '30min_to_2h'
          WHEN EXTRACT(EPOCH FROM (last_salesman_reply_at - last_customer_reply_at)) / 60 < 240 THEN '2h_to_4h'
          ELSE 'over_4h'
        END AS bucket,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'CONVERTED') AS converted
      FROM leads l
      ${where}
      GROUP BY 1
      ORDER BY
        CASE bucket
          WHEN 'under_30min' THEN 1
          WHEN '30min_to_2h' THEN 2
          WHEN '2h_to_4h'    THEN 3
          WHEN 'over_4h'     THEN 4
          WHEN 'unanswered'  THEN 5
        END
    `, params);

    const BUCKET_LABELS: Record<string, string> = {
      under_30min: '< 30 min',
      '30min_to_2h': '30 min – 2 h',
      '2h_to_4h': '2 h – 4 h',
      over_4h: '> 4 h',
      unanswered: 'Unanswered',
    };

    return rows.map((r: any) => ({
      bucket: r.bucket,
      label: BUCKET_LABELS[r.bucket] || r.bucket,
      total: +r.total,
      converted: +r.converted,
      conversionPct: +r.total > 0 ? Math.round((+r.converted / +r.total) * 100) : 0,
    }));
  }

  // ── Operational lead quality guard ────────────────────────────────────────────
  // Sourced from crm.constants.ts — single definition for all operational filters.
  private static readonly OPERATIONAL_QUALITY_FILTER = CRM_OPERATIONAL_QUALITY_SQL;

  // ── Part 1: Objection Intelligence ────────────────────────────────────────────

  async getObjectionIntelligence(user: any) {
    const where = this.isFullAccess(user)
      ? `WHERE l.last_objection_type IS NOT NULL AND l.is_active = true AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality')}`
      : `WHERE l.last_objection_type IS NOT NULL AND l.is_active = true AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality')} AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];

    const rows: any[] = await this.ds.query(`
      SELECT
        l.last_objection_type                                      AS objection,
        COUNT(DISTINCT l.id)                                       AS total_count,
        COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'CONVERTED') AS converted_count,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400.0
        ) FILTER (WHERE l.status = 'CONVERTED')::numeric, 1)      AS avg_days_to_conversion,
        ROUND(AVG(q.total_amount) FILTER (WHERE q.id IS NOT NULL)::numeric, 0) AS avg_quotation_value,
        (
          SELECT l2.workflow_state
          FROM leads l2
          WHERE l2.last_objection_type = l.last_objection_type
            AND l2.status IN ('LOST', 'CONVERTED')
            AND l2.workflow_state IS NOT NULL
          GROUP BY l2.workflow_state
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS common_exit_state
      FROM leads l
      LEFT JOIN quotation q ON q.lead_id = l.id AND q.status != 'DRAFT'
      ${where}
      GROUP BY l.last_objection_type
      ORDER BY total_count DESC
    `, params);

    return rows.map((r: any) => ({
      objection:           r.objection,
      totalCount:          +r.total_count,
      convertedCount:      +r.converted_count,
      conversionPct:       +r.total_count > 0 ? Math.round((+r.converted_count / +r.total_count) * 100) : 0,
      avgDaysToConversion: r.avg_days_to_conversion !== null ? +r.avg_days_to_conversion : null,
      avgQuotationValue:   r.avg_quotation_value !== null ? Math.round(+r.avg_quotation_value) : null,
      commonExitState:     r.common_exit_state ?? null,
      isFatal:             +r.total_count > 0 && Math.round((+r.converted_count / +r.total_count) * 100) < 10,
    }));
  }

  // ── Part 2: Workflow State Funnel ─────────────────────────────────────────────

  async getWorkflowFunnel(user: any) {
    const assignFilter = this.isFullAccess(user)
      ? '' : `AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];
    const qualFilter = AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality');

    const stateRows: any[] = await this.ds.query(`
      SELECT
        l.workflow_state                                                  AS state,
        COUNT(*)                                                          AS current_count,
        COUNT(*) FILTER (WHERE l.next_action_due_at < NOW())              AS overdue_count,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0
        )::numeric, 1)                                                    AS avg_hours_in_state,
        COUNT(*) FILTER (WHERE COALESCE(l.tags,'[]'::jsonb) @> '["stale_lead"]') AS stale_count
      FROM leads l
      WHERE l.is_active = true
        AND l.workflow_state IS NOT NULL
        AND ${qualFilter}
        ${assignFilter}
      GROUP BY l.workflow_state
      ORDER BY
        CASE l.workflow_state
          WHEN 'FIRST_CALL'      THEN 1
          WHEN 'NO_ANSWER_1'     THEN 2
          WHEN 'NO_ANSWER_2'     THEN 3
          WHEN 'NO_ANSWER_ESC'   THEN 4
          WHEN 'FOLLOW_UP'       THEN 5
          WHEN 'CALLBACK_WAIT'   THEN 6
          WHEN 'SEND_QUOTATION'  THEN 7
          WHEN 'CHASE_QUOTATION' THEN 8
          WHEN 'NEGOTIATING'     THEN 9
          WHEN 'NURTURE'         THEN 10
          WHEN 'CONVERTED'       THEN 11
          WHEN 'LOST'            THEN 12
          ELSE 99
        END
    `, params);

    const totalActive = stateRows.reduce((s: number, r: any) =>
      ['CONVERTED', 'LOST'].includes(r.state) ? s : s + +r.current_count, 0);

    return stateRows.map((r: any) => ({
      state:           r.state,
      currentCount:    +r.current_count,
      overdueCount:    +r.overdue_count,
      avgHoursInState: r.avg_hours_in_state !== null ? +r.avg_hours_in_state : null,
      staleCount:      +r.stale_count,
      pctOfActive:     totalActive > 0 && !['CONVERTED', 'LOST'].includes(r.state)
        ? Math.round((+r.current_count / totalActive) * 100) : null,
    }));
  }

  // ── Part 3: Quotation Performance ─────────────────────────────────────────────

  async getQuotationPerformance(user: any) {
    const assignFilter = this.isFullAccess(user)
      ? '' : `AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];
    const qualFilter = AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality');

    const [r]: any[] = await this.ds.query(`
      SELECT
        COUNT(DISTINCT q.id)                                                           AS total,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'DRAFT')                         AS draft,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'GENERATED')                     AS generated,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'CONVERTED')                     AS converted,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'CANCELLED')                     AS cancelled,
        COUNT(DISTINCT q.id) FILTER (
          WHERE q.status = 'GENERATED' AND l.workflow_state = 'NEGOTIATING'
        )                                                                               AS negotiating,
        COUNT(DISTINCT q.id) FILTER (
          WHERE q.status = 'GENERATED'
            AND q.created_at < NOW() - INTERVAL '7 days'
            AND l.status NOT IN ('CONVERTED', 'LOST')
        )                                                                               AS stalled,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (q.created_at - l.created_at)) / 3600.0
        ) FILTER (WHERE q.status != 'DRAFT')::numeric, 1)                              AS avg_hours_to_quote,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (o.created_at - q.created_at)) / 86400.0
        ) FILTER (WHERE o.id IS NOT NULL)::numeric, 1)                                 AS avg_days_to_convert,
        ROUND(AVG(q.total_amount) FILTER (WHERE q.status = 'CONVERTED')::numeric, 0)  AS avg_converted_value,
        ROUND(AVG(q.total_amount)::numeric, 0)                                         AS avg_all_value,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'CONVERTED') * 100.0 /
          NULLIF(COUNT(DISTINCT q.id) FILTER (WHERE q.status != 'DRAFT'), 0)           AS conversion_pct_of_sent
      FROM quotation q
      JOIN leads l ON l.id = q.lead_id
      LEFT JOIN orders o ON o.lead_id = l.id AND o.status != 'CANCELLED'
      WHERE l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);

    const total = +r.total || 0;
    return {
      total,
      draft:            +r.draft,
      generated:        +r.generated,
      converted:        +r.converted,
      cancelled:        +r.cancelled,
      negotiating:      +r.negotiating,
      stalled:          +r.stalled,
      conversionPct:    total > 0 ? Math.round((+r.converted / total) * 100) : 0,
      conversionPctOfSent: r.conversion_pct_of_sent !== null ? Math.round(+r.conversion_pct_of_sent) : 0,
      avgHoursToQuote:  r.avg_hours_to_quote !== null ? +r.avg_hours_to_quote : null,
      avgDaysToConvert: r.avg_days_to_convert !== null ? +r.avg_days_to_convert : null,
      avgConvertedValue: r.avg_converted_value !== null ? Math.round(+r.avg_converted_value) : null,
      avgAllValue:      r.avg_all_value !== null ? Math.round(+r.avg_all_value) : null,
    };
  }

  // ── Part 4: Product Conversion Intelligence ───────────────────────────────────

  async getProductConversion(user: any) {
    const assignFilter = this.isFullAccess(user)
      ? '' : `AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];
    const qualFilter = AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality');

    const rows: any[] = await this.ds.query(`
      SELECT
        TRIM(LOWER(l.product_interest))                                     AS product,
        COUNT(DISTINCT l.id)                                                AS lead_count,
        COUNT(DISTINCT q.id)                                                AS quotation_count,
        COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'CONVERTED')          AS converted_count,
        ROUND(AVG(o.total_amount) FILTER (WHERE o.id IS NOT NULL)::numeric, 0) AS avg_order_value,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400.0
        ) FILTER (WHERE l.status = 'CONVERTED')::numeric, 1)               AS avg_sales_cycle_days,
        (
          SELECT l2.last_objection_type
          FROM leads l2
          WHERE TRIM(LOWER(l2.product_interest)) = TRIM(LOWER(l.product_interest))
            AND l2.last_objection_type IS NOT NULL
          GROUP BY l2.last_objection_type
          ORDER BY COUNT(*) DESC
          LIMIT 1
        )                                                                   AS most_common_objection
      FROM leads l
      LEFT JOIN quotation q ON q.lead_id = l.id
      LEFT JOIN orders o ON o.lead_id = l.id AND o.status != 'CANCELLED'
      WHERE l.product_interest IS NOT NULL
        AND TRIM(l.product_interest) != ''
        AND l.is_active = true
        AND ${qualFilter}
        ${assignFilter}
      GROUP BY TRIM(LOWER(l.product_interest))
      HAVING COUNT(DISTINCT l.id) >= 2
      ORDER BY converted_count DESC, lead_count DESC
      LIMIT 20
    `, params);

    return rows.map((r: any) => ({
      product:            r.product,
      leadCount:          +r.lead_count,
      quotationCount:     +r.quotation_count,
      convertedCount:     +r.converted_count,
      conversionPct:      +r.lead_count > 0 ? Math.round((+r.converted_count / +r.lead_count) * 100) : 0,
      avgOrderValue:      r.avg_order_value !== null ? Math.round(+r.avg_order_value) : null,
      avgSalesCycleDays:  r.avg_sales_cycle_days !== null ? +r.avg_sales_cycle_days : null,
      mostCommonObjection: r.most_common_objection ?? null,
    }));
  }

  // ── Part 5: Telecaller Effectiveness (conversion-centric) ─────────────────────

  async getTelecallerEffectiveness(user: any) {
    const rows: any[] = await this.ds.query(`
      SELECT
        u.id              AS user_id,
        u.name            AS user_name,

        -- Pipeline totals
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.is_active = true
           AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER}
        ) AS total_leads,

        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'CONVERTED'
           AND l.is_active = true AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER}
        ) AS converted,

        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'LOST'
           AND l.is_active = true AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER}
        ) AS lost,

        -- Quotation generation: leads that have at least one quotation
        (SELECT COUNT(DISTINCT q.lead_id) FROM quotation q
           JOIN leads l ON l.id = q.lead_id AND l.assigned_to = u.id
           AND l.is_active = true AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER}
        ) AS leads_with_quotation,

        -- Avg hours from lead creation to first quotation
        (SELECT ROUND(AVG(
             EXTRACT(EPOCH FROM (q_first.first_quote - l.created_at)) / 3600.0
           )::numeric, 1)
         FROM leads l
         JOIN (SELECT lead_id, MIN(created_at) AS first_quote FROM quotation GROUP BY lead_id) q_first
           ON q_first.lead_id = l.id
         WHERE l.assigned_to = u.id AND l.is_active = true
           AND ${AnalyticsService.OPERATIONAL_QUALITY_FILTER}
        ) AS avg_hours_to_quotation,

        -- Callback success rate: CALLBACK_WAIT leads that advanced beyond it
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND l.workflow_state NOT IN ('CALLBACK_WAIT', 'LOST')
           AND l.last_outcome_type = 'LATER'
           AND l.call_attempt_count > 1
           AND l.is_active = true
        ) AS callback_successes,

        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND l.last_outcome_type = 'LATER'
           AND l.is_active = true
        ) AS callback_total,

        -- Objection recovery: NOT_INTERESTED leads that later converted
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND l.status = 'CONVERTED'
           AND l.last_objection_type IS NOT NULL
           AND l.is_active = true
        ) AS objection_recoveries,

        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND l.last_objection_type IS NOT NULL
           AND l.is_active = true
        ) AS objection_total,

        -- Negotiation success: NEGOTIATING leads that converted
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND l.status = 'CONVERTED'
           AND l.last_contacted_at IS NOT NULL
           AND l.no_answer_count < 3
           AND l.is_active = true
        ) AS negotiation_successes,

        -- Stale leads
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
           AND COALESCE(l.tags,'[]'::jsonb) @> '["stale_lead"]'
           AND l.is_active = true
        ) AS stale_count

      FROM "user" u
      WHERE u.role IN ('Tele calling Executive', 'Territory Manager', 'Field Executive')
        AND u.is_active = true
      ORDER BY converted DESC NULLS LAST
    `);

    return rows.map((r: any) => {
      const totalLeads = +r.total_leads || 0;
      const converted  = +r.converted || 0;
      const leadsWithQ = +r.leads_with_quotation || 0;
      const cbSucc     = +r.callback_successes || 0;
      const cbTotal    = +r.callback_total || 1;
      const objRecov   = +r.objection_recoveries || 0;
      const objTotal   = +r.objection_total || 1;
      return {
        userId:                   +r.user_id,
        userName:                 r.user_name,
        totalLeads,
        converted,
        lost:                     +r.lost,
        conversionRate:           totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0,
        quotationGenerationRate:  totalLeads > 0 ? Math.round((leadsWithQ / totalLeads) * 100) : 0,
        avgHoursToQuotation:      r.avg_hours_to_quotation !== null ? +r.avg_hours_to_quotation : null,
        callbackSuccessRate:      Math.round((cbSucc / cbTotal) * 100),
        objectionRecoveryRate:    Math.round((objRecov / objTotal) * 100),
        staleLeadCount:           +r.stale_count,
        staleLeadRate:            totalLeads > 0 ? Math.round((+r.stale_count / totalLeads) * 100) : 0,
      };
    });
  }

  // ── Part 6: Pipeline Leak Detection ──────────────────────────────────────────

  async getPipelineLeaks(user: any) {
    const assignFilter = this.isFullAccess(user)
      ? '' : `AND (l.assigned_to = $1 OR l.created_by = $1)`;
    const params = this.isFullAccess(user) ? [] : [user.id];
    const qualFilter = AnalyticsService.OPERATIONAL_QUALITY_FILTER.replace(/lead_quality/g, 'l.lead_quality');

    const leaks: Array<{
      stage: string;
      leakReason: string;
      affectedCount: number;
      avgAgingHours: number | null;
      operationalCause: string;
      severity: 'HIGH' | 'MEDIUM' | 'LOW';
    }> = [];

    // 1. NO_ANSWER_ESC accumulation → slow first response
    const [naEsc]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE l.workflow_state = 'NO_ANSWER_ESC' AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+naEsc.cnt > 0) leaks.push({
      stage: 'NO_ANSWER_ESC', leakReason: 'Unreachable leads accumulating',
      affectedCount: +naEsc.cnt, avgAgingHours: naEsc.avg_hours !== null ? +naEsc.avg_hours : null,
      operationalCause: 'Slow first response or wrong contact hours — increase call attempt spread',
      severity: +naEsc.cnt >= 10 ? 'HIGH' : +naEsc.cnt >= 5 ? 'MEDIUM' : 'LOW',
    });

    // 2. SEND_QUOTATION aging >4h with no quotation sent
    const [sqStale]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE l.workflow_state = 'SEND_QUOTATION'
        AND l.quotation_id IS NULL
        AND COALESCE(l.workflow_state_entered_at, l.created_at) < NOW() - INTERVAL '4 hours'
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+sqStale.cnt > 0) leaks.push({
      stage: 'SEND_QUOTATION', leakReason: 'Quotation not sent after interest confirmed',
      affectedCount: +sqStale.cnt, avgAgingHours: sqStale.avg_hours !== null ? +sqStale.avg_hours : null,
      operationalCause: 'Quotation turnaround delay — assign pricing authority or pre-built templates',
      severity: +sqStale.cnt >= 5 ? 'HIGH' : +sqStale.cnt >= 2 ? 'MEDIUM' : 'LOW',
    });

    // 3. CHASE_QUOTATION aging >72h
    const [cqStale]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE l.workflow_state = 'CHASE_QUOTATION'
        AND COALESCE(l.workflow_state_entered_at, l.created_at) < NOW() - INTERVAL '72 hours'
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+cqStale.cnt > 0) leaks.push({
      stage: 'CHASE_QUOTATION', leakReason: 'Quotation follow-up gap >72h',
      affectedCount: +cqStale.cnt, avgAgingHours: cqStale.avg_hours !== null ? +cqStale.avg_hours : null,
      operationalCause: 'Post-quotation follow-up gap — call 3 days post-send, lead goes cold otherwise',
      severity: +cqStale.cnt >= 5 ? 'HIGH' : +cqStale.cnt >= 2 ? 'MEDIUM' : 'LOW',
    });

    // 4. CALLBACK_WAIT overdue (promised callback missed)
    const [cbOver]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - l.next_action_due_at)) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE l.workflow_state = 'CALLBACK_WAIT'
        AND l.next_action_due_at < NOW()
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+cbOver.cnt > 0) leaks.push({
      stage: 'CALLBACK_WAIT', leakReason: 'Promised callbacks not honored',
      affectedCount: +cbOver.cnt, avgAgingHours: cbOver.avg_hours !== null ? +cbOver.avg_hours : null,
      operationalCause: 'Callback discipline issue — customer expectation not met, trust erodes fast',
      severity: +cbOver.cnt >= 3 ? 'HIGH' : +cbOver.cnt >= 1 ? 'MEDIUM' : 'LOW',
    });

    // 5. Stale lead accumulation (tagged stale_lead)
    const [staleLds]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE COALESCE(l.tags,'[]'::jsonb) @> '["stale_lead"]'
        AND l.status NOT IN ('CONVERTED', 'LOST')
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+staleLds.cnt > 0) leaks.push({
      stage: 'PIPELINE', leakReason: 'Leads stagnating with no call activity',
      affectedCount: +staleLds.cnt, avgAgingHours: staleLds.avg_hours !== null ? +staleLds.avg_hours : null,
      operationalCause: 'Telecaller inactivity — missed SLA×2 call window, leads going cold',
      severity: +staleLds.cnt >= 10 ? 'HIGH' : +staleLds.cnt >= 5 ? 'MEDIUM' : 'LOW',
    });

    // 6. NEGOTIATING stall >96h
    const [negStale]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.workflow_state_entered_at, l.created_at))) / 3600.0)::numeric, 1) AS avg_hours
      FROM leads l
      WHERE l.workflow_state = 'NEGOTIATING'
        AND COALESCE(l.workflow_state_entered_at, l.created_at) < NOW() - INTERVAL '96 hours'
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+negStale.cnt > 0) leaks.push({
      stage: 'NEGOTIATING', leakReason: 'Negotiation stall >96h',
      affectedCount: +negStale.cnt, avgAgingHours: negStale.avg_hours !== null ? +negStale.avg_hours : null,
      operationalCause: 'Negotiation stall — involve senior, offer alternative pricing, set hard close date',
      severity: +negStale.cnt >= 3 ? 'HIGH' : +negStale.cnt >= 1 ? 'MEDIUM' : 'LOW',
    });

    // 7. Callback abuse risk — leads looping through LATER outcomes
    const [cbAbuse]: any = await this.ds.query(`
      SELECT COUNT(*) AS cnt
      FROM leads l
      WHERE COALESCE(l.tags,'[]'::jsonb) @> '["callback_abuse_risk"]'
        AND l.status NOT IN ('CONVERTED', 'LOST')
        AND l.is_active = true AND ${qualFilter} ${assignFilter}
    `, params);
    if (+cbAbuse.cnt > 0) leaks.push({
      stage: 'CALLBACK_WAIT', leakReason: 'Callback abuse — repeated deferrals',
      affectedCount: +cbAbuse.cnt, avgAgingHours: null,
      operationalCause: 'Leads being pushed repeatedly without qualification — review and close or disqualify',
      severity: +cbAbuse.cnt >= 5 ? 'HIGH' : +cbAbuse.cnt >= 2 ? 'MEDIUM' : 'LOW',
    });

    return leaks.sort((a, b) => {
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (rank[a.severity] - rank[b.severity]) || (b.affectedCount - a.affectedCount);
    });
  }

  // ── Source volume: today + last 7 days ───────────────────────────────────────
  // Restricted to manager roles — operator-facing dashboard card.
  // Returns flat { SOURCE: count } maps for direct consumption.

  async getTodayBySource(): Promise<{ today: Record<string, number>; last7Days: Record<string, number> }> {
    const [todayRows, weekRows] = await Promise.all([
      this.ds.query(`
        SELECT source, COUNT(*) AS cnt
        FROM leads
        WHERE created_at >= CURRENT_DATE
          AND is_active = true
        GROUP BY source
        ORDER BY cnt DESC
      `),
      this.ds.query(`
        SELECT source, COUNT(*) AS cnt
        FROM leads
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND is_active = true
        GROUP BY source
        ORDER BY cnt DESC
      `),
    ]);

    const toMap = (rows: any[]) =>
      rows.reduce((acc: Record<string, number>, r: any) => {
        acc[r.source] = +r.cnt;
        return acc;
      }, {});

    return { today: toMap(todayRows), last7Days: toMap(weekRows) };
  }

  // ── Part 7: Source Health Engine ─────────────────────────────────────────────
  // Covers ALL leads (no is_active filter) — full ingestion picture, not operational view.
  // Restricted to Admin/COO/Sales Manager at the controller layer.

  private static computeSourceReliability(
    identityRate: number,
    noiseRate: number,
    archivedInvalidCount: number,
  ): 'HEALTHY' | 'WARNING' | 'CRITICAL' {
    if (identityRate < 20 || noiseRate > 50 || archivedInvalidCount > 5) return 'CRITICAL';
    if (identityRate < 60 || noiseRate > 20 || archivedInvalidCount > 0) return 'WARNING';
    return 'HEALTHY';
  }

  async getSourceHealth(): Promise<{
    sources: any[];
    issues: any[];
    duplicatePatterns: { suspectedDuplicateCount: number; patterns: any[] };
  }> {
    // ── 1. Main per-source aggregation (all leads, including archived) ──────────
    const sourceRows: any[] = await this.ds.query(`
      SELECT
        COALESCE(l.source, 'OTHER')                                          AS source,
        COUNT(*)                                                              AS total,
        COUNT(*) FILTER (WHERE l.is_active = true)                           AS active_count,
        COUNT(*) FILTER (WHERE l.status = 'CONVERTED')                       AS converted_count,
        COUNT(*) FILTER (WHERE l.status = 'LOST')                            AS lost_count,
        COUNT(*) FILTER (
          WHERE COALESCE(l.tags,'[]'::jsonb) @> '["archived_invalid_identity"]'
        )                                                                     AS archived_invalid_count,
        COUNT(*) FILTER (WHERE l.lead_quality = 'TRACKING_ONLY')             AS tracking_only_count,
        COUNT(*) FILTER (WHERE l.lead_quality = 'JUNK')                      AS junk_count,
        COUNT(*) FILTER (WHERE l.lead_quality = 'DUPLICATE')                 AS duplicate_count,
        COUNT(*) FILTER (WHERE l.lead_quality = 'AUTO_CAPTURED')             AS auto_captured_count,
        COUNT(*) FILTER (WHERE l.phone IS NOT NULL OR l.email IS NOT NULL)   AS identified_count,
        COUNT(*) FILTER (WHERE l.phone IS NOT NULL)                          AS phone_count,
        COUNT(*) FILTER (WHERE l.email IS NOT NULL)                          AS email_count,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400.0
        ) FILTER (WHERE l.status = 'CONVERTED')::numeric, 1)                 AS avg_days_to_conversion,
        COUNT(*) FILTER (
          WHERE l.is_active = true
            AND COALESCE(l.tags,'[]'::jsonb) @> '["stale_lead"]'
            AND l.status NOT IN ('CONVERTED','LOST')
        )                                                                     AS stale_count,
        COUNT(*) FILTER (
          WHERE l.is_active = true AND l.workflow_state = 'NO_ANSWER_ESC'
        )                                                                     AS no_answer_esc_count,
        COUNT(*) FILTER (
          WHERE l.is_active = true
            AND COALESCE(l.tags,'[]'::jsonb) @> '["callback_abuse_risk"]'
        )                                                                     AS callback_abuse_count
      FROM leads l
      GROUP BY COALESCE(l.source, 'OTHER')
      ORDER BY total DESC
    `);

    // ── 2. Avg first-response time per source (only identified leads) ───────────
    const responseRows: any[] = await this.ds.query(`
      SELECT l.source AS source,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (fc.first_call - l.created_at)) / 60.0
        )::numeric, 1) AS avg_response_min
      FROM leads l
      JOIN (
        SELECT lead_id, MIN(created_at) AS first_call
        FROM lead_audit_logs
        WHERE action = 'CALLED'
        GROUP BY lead_id
      ) fc ON fc.lead_id = l.id
      WHERE l.phone IS NOT NULL OR l.email IS NOT NULL
      GROUP BY l.source
    `);
    const responseMap: Record<string, number | null> = {};
    for (const r of responseRows) {
      responseMap[r.source] = r.avg_response_min !== null ? +r.avg_response_min : null;
    }

    // ── 3. Duplicate phone pattern detection ──────────────────────────────────
    const dupRows: any[] = await this.ds.query(`
      SELECT
        phone,
        COUNT(*)                    AS occurrence_count,
        COUNT(DISTINCT source)      AS source_count,
        array_agg(DISTINCT source)  AS sources,
        MIN(created_at)             AS first_seen,
        MAX(created_at)             AS last_seen
      FROM leads
      WHERE phone IS NOT NULL AND TRIM(phone) != ''
      GROUP BY phone
      HAVING COUNT(*) >= 2
      ORDER BY occurrence_count DESC
      LIMIT 20
    `);

    // ── 4. Build enriched source objects + issues ─────────────────────────────
    const sources = sourceRows.map((r: any) => {
      const total              = +r.total || 0;
      const activeCount        = +r.active_count || 0;
      const convertedCount     = +r.converted_count || 0;
      const lostCount          = +r.lost_count || 0;
      const archivedInvalid    = +r.archived_invalid_count || 0;
      const trackingOnlyCount  = +r.tracking_only_count || 0;
      const junkCount          = +r.junk_count || 0;
      const duplicateCount     = +r.duplicate_count || 0;
      const autoCapturedCount  = +r.auto_captured_count || 0;
      const identifiedCount    = +r.identified_count || 0;
      const phoneCount         = +r.phone_count || 0;
      const emailCount         = +r.email_count || 0;
      const staleCount         = +r.stale_count || 0;
      const noAnswerEscCount   = +r.no_answer_esc_count || 0;
      const callbackAbuseCount = +r.callback_abuse_count || 0;

      const identityRate     = total > 0 ? Math.round((identifiedCount / total) * 100) : 0;
      const phoneRate        = total > 0 ? Math.round((phoneCount / total) * 100) : 0;
      const emailRate        = total > 0 ? Math.round((emailCount / total) * 100) : 0;
      const conversionRate   = total > 0 ? Math.round((convertedCount / total) * 100) : 0;
      const noiseRate        = total > 0 ? Math.round(((trackingOnlyCount + junkCount) / total) * 100) : 0;
      const staleRate        = activeCount > 0 ? Math.round((staleCount / activeCount) * 100) : 0;
      const noAnswerEscRate  = activeCount > 0 ? Math.round((noAnswerEscCount / activeCount) * 100) : 0;
      const callbackAbuseRate= activeCount > 0 ? Math.round((callbackAbuseCount / activeCount) * 100) : 0;

      const reliability = AnalyticsService.computeSourceReliability(
        identityRate, noiseRate, archivedInvalid,
      );

      return {
        source:              r.source,
        totalLeadCount:      total,
        activeLeadCount:     activeCount,
        convertedLeadCount:  convertedCount,
        lostLeadCount:       lostCount,
        archivedInvalidCount: archivedInvalid,
        trackingOnlyCount,
        junkCount,
        duplicateCount,
        autoCapturedCount,
        identityRate,
        phoneRate,
        emailRate,
        conversionRate,
        noiseRate,
        staleLeadRate:          staleRate,
        noAnswerEscalationRate: noAnswerEscRate,
        callbackAbuseRate,
        avgResponseMinutes:     responseMap[r.source] ?? null,
        avgDaysToConversion:    r.avg_days_to_conversion !== null ? +r.avg_days_to_conversion : null,
        reliability,
      };
    });

    // ── 5. Generate deterministic issues list ─────────────────────────────────
    const issues: Array<{ severity: 'CRITICAL'|'WARNING'; source: string; message: string }> = [];
    for (const s of sources) {
      if (s.totalLeadCount === 0) continue;
      if (s.identityRate < 20) {
        issues.push({ severity: 'CRITICAL', source: s.source,
          message: `${s.source}: ${s.identityRate}% identity rate — most ingested leads have no phone or email. Webhook field mapping may be broken.` });
      } else if (s.identityRate < 60) {
        issues.push({ severity: 'WARNING', source: s.source,
          message: `${s.source}: low identity rate (${s.identityRate}%) — integration is missing contact fields on many leads.` });
      }
      if (s.noiseRate > 50) {
        issues.push({ severity: 'CRITICAL', source: s.source,
          message: `${s.source}: ${s.noiseRate}% tracking/junk ratio — platform is generating mostly non-actionable anonymous traffic.` });
      } else if (s.noiseRate > 20) {
        issues.push({ severity: 'WARNING', source: s.source,
          message: `${s.source}: ${s.noiseRate}% of leads are tracking-only or junk — high noise ratio.` });
      }
      if (s.archivedInvalidCount > 5) {
        issues.push({ severity: 'CRITICAL', source: s.source,
          message: `${s.source}: ${s.archivedInvalidCount} leads archived for missing identity — repeated ingestion without contact data.` });
      } else if (s.archivedInvalidCount > 0) {
        issues.push({ severity: 'WARNING', source: s.source,
          message: `${s.source}: ${s.archivedInvalidCount} lead(s) archived for missing identity — verify webhook payload mapping.` });
      }
      if (s.duplicateCount > 10) {
        issues.push({ severity: 'WARNING', source: s.source,
          message: `${s.source}: ${s.duplicateCount} duplicate phone collisions — platform is re-submitting existing contacts.` });
      }
      if (s.noAnswerEscalationRate > 30) {
        issues.push({ severity: 'WARNING', source: s.source,
          message: `${s.source}: ${s.noAnswerEscalationRate}% of active leads have escalated no-answers — contact quality or timing issue.` });
      }
    }
    // CRITICAL first, then WARNING
    issues.sort((a, b) => (a.severity === 'CRITICAL' ? -1 : 1) - (b.severity === 'CRITICAL' ? -1 : 1));

    // ── 6. Duplicate pattern summary ──────────────────────────────────────────
    const patterns = dupRows.map((r: any) => ({
      phone:           r.phone,
      occurrenceCount: +r.occurrence_count,
      sourceCount:     +r.source_count,
      sources:         r.sources,
      firstSeen:       r.first_seen,
      lastSeen:        r.last_seen,
    }));

    return {
      sources,
      issues,
      duplicatePatterns: {
        suspectedDuplicateCount: patterns.length,
        patterns,
      },
    };
  }

  async getTelecallerMetrics(user: any) {
    const rows: any[] = await this.ds.query(`
      SELECT
        u.id                          AS user_id,
        u.name                        AS user_name,

        -- Leads with next_action_due_at in the past (active pipeline only)
        (SELECT COUNT(*) FROM leads l
         WHERE l.assigned_to = u.id
           AND l.next_action_due_at < NOW()
           AND l.status NOT IN ('CONVERTED', 'LOST')
           AND l.is_active = true
        )                             AS overdue_lead_count,

        -- Leads tagged stale_lead (no call in SLA×2 window)
        (SELECT COUNT(*) FROM leads l
         WHERE l.assigned_to = u.id
           AND COALESCE(l.tags, '[]'::jsonb) @> '["stale_lead"]'
           AND l.is_active = true
        )                             AS stale_lead_count,

        -- Leads tagged callback_abuse_risk
        (SELECT COUNT(*) FROM leads l
         WHERE l.assigned_to = u.id
           AND COALESCE(l.tags, '[]'::jsonb) @> '["callback_abuse_risk"]'
           AND l.is_active = true
        )                             AS callback_abuse_count,

        -- Leads with no_answer_count >= 5 (operationally blocked)
        (SELECT COUNT(*) FROM leads l
         WHERE l.assigned_to = u.id
           AND l.no_answer_count >= 5
           AND l.is_active = true
        )                             AS no_answer_escalations,

        -- Avg minutes from lead creation to first CALL audit entry (response speed)
        (SELECT AVG(EXTRACT(EPOCH FROM (lal.first_call - l.created_at)) / 60)
         FROM leads l
         JOIN (
           SELECT lead_id, MIN(created_at) AS first_call
           FROM lead_audit_logs
           WHERE action = 'CALLED'
           GROUP BY lead_id
         ) lal ON lal.lead_id = l.id
         WHERE l.assigned_to = u.id
           AND l.is_active = true
        )                             AS avg_first_response_minutes,

        -- Leads auto-reassigned away from this user in last 30 days
        (SELECT COUNT(DISTINCT l.id) FROM leads l
         WHERE l.assigned_to != u.id
           AND EXISTS (
             SELECT 1 FROM lead_audit_logs lal
             WHERE lal.lead_id = l.id
               AND lal.action = 'ESCALATED'
               AND lal.detail LIKE '%AUTO_REASSIGN%'
               AND lal.created_at > NOW() - INTERVAL '30 days'
           )
           AND EXISTS (
             SELECT 1 FROM lead_audit_logs lal2
             WHERE lal2.lead_id = l.id
               AND lal2.user_id = u.id
               AND lal2.action = 'VIEWED'
               AND lal2.created_at < NOW() - INTERVAL '72 hours'
           )
        )                             AS reassignment_count,

        -- Leads with 3+ snoozes in 30 days assigned to this user
        (SELECT COUNT(*) FROM (
           SELECT lead_id FROM lead_audit_logs lal
           JOIN leads l ON l.id = lal.lead_id AND l.assigned_to = u.id
           WHERE lal.action = 'UPDATED'
             AND lal.detail LIKE 'Automation snoozed%'
             AND lal.created_at > NOW() - INTERVAL '30 days'
           GROUP BY lal.lead_id
           HAVING COUNT(*) >= 3
         ) snooze_abused
        )                             AS snooze_abuse_count

      FROM "user" u
      WHERE u.role IN ('Tele calling Executive', 'Territory Manager', 'Field Executive')
        AND u.is_active = true
      ORDER BY overdue_lead_count DESC NULLS LAST
    `);

    return rows.map((r: any) => ({
      userId:                  +r.user_id,
      userName:                r.user_name,
      overdueLeadCount:        +r.overdue_lead_count,
      staleLeadCount:          +r.stale_lead_count,
      callbackAbuseCount:      +r.callback_abuse_count,
      noAnswerEscalations:     +r.no_answer_escalations,
      avgFirstResponseMinutes: r.avg_first_response_minutes !== null ? Math.round(+r.avg_first_response_minutes) : null,
      reassignmentCount:       +r.reassignment_count,
      snoozeAbuseCount:        +r.snooze_abuse_count,
    }));
  }

  // ── Top campaigns by UTM ──────────────────────────────────────────────────────

  async getTopCampaigns(days = 30): Promise<{ campaign: string; source: string; count: number }[]> {
    const rows = await this.ds.query(`
      SELECT
        COALESCE(raw_payload->>'utm_campaign', '(direct)') AS campaign,
        COALESCE(raw_payload->>'utm_source', source)       AS source,
        COUNT(*)::int                                       AS count
      FROM leads
      WHERE is_active = true
        AND created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY campaign, source
      ORDER BY count DESC
      LIMIT 20
    `, [days]);
    return rows.map((r: any) => ({ campaign: r.campaign, source: r.source, count: +r.count }));
  }

  // ── Conversion funnel: Leads → Quotations → Orders ───────────────────────────

  async getConversionFunnel(): Promise<{ leads: number; quotations: number; orders: number }> {
    const [r] = await this.ds.query(`
      SELECT
        (SELECT COUNT(*) FROM leads WHERE is_active = true)                     AS leads,
        (SELECT COUNT(*) FROM quotation WHERE status != 'DRAFT')                AS quotations,
        (SELECT COUNT(*) FROM orders  WHERE status NOT IN ('CANCELLED','DRAFT')) AS orders
    `);
    return {
      leads:      +r.leads,
      quotations: +r.quotations,
      orders:     +r.orders,
    };
  }
}

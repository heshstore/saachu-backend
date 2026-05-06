import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class AnalyticsService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  private isFullAccess(user: any) {
    return ['Admin', 'COO', 'Sales Manager'].includes(user?.role);
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
}

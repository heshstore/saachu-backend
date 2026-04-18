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
      `SELECT id, name, role FROM "user" WHERE id = $1`,
      [telecallerId],
    );

    return {
      telecaller: user_row[0] ?? null,
      breakdown: rows,
    };
  }
}

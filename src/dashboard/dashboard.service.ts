import { Injectable } from '@nestjs/common';
import { DataSource }  from 'typeorm';
import { ManufacturingAnalyticsService } from '../manufacturing-analytics/manufacturing-analytics.service';
import { FinanceOpsService } from '../finance-ops/finance-ops.service';
import type { FinanceDashboardSummary } from '../finance-ops/finance-ops.service';

export interface DashboardSummary {
  orders: {
    total_orders:       number;
    in_production:      number;
    ready_for_dispatch: number;
    dispatched:         number;
    completed:          number;
  };
  payments: {
    total_revenue:     number;
    total_outstanding: number;
    today_collection:  number;
  };
  production: {
    active_jobs:          number;
    jobs_completed_today: number;
  };
  /** Read-only manufacturing / dispatch exposure (optional — zeros if tables missing) */
  manufacturing_intel?: {
    wip_order_value:           number;
    delayed_execution_hints:   number;
    pending_dispatch_value:    number;
    procurement_exposure:      number;
    fg_stock_value:            number;
    active_execution_jobs:     number;
    loss_making_orders:        number;
    production_efficiency_pct: number;
  };
  /** Phase 14 — operational receivables / payables (no accounting engine). */
  finance_ops?: FinanceDashboardSummary;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly manufacturingAnalytics: ManufacturingAnalyticsService,
    private readonly financeOps: FinanceOpsService,
  ) {}

  async getSummary(): Promise<DashboardSummary> {
    // Four lightweight aggregate queries run in parallel — no full table scans.
    const [orderRows, revenueRows, todayRows, jobRows] = await Promise.all([
      this.dataSource.query<Record<string, string>[]>(`
        SELECT
          COUNT(*)::int                                                   AS total_orders,
          COUNT(*) FILTER (WHERE status = 'IN_PRODUCTION')::int          AS in_production,
          COUNT(*) FILTER (WHERE status IN ('READY', 'READY_FOR_DISPATCH', 'PARTIAL_DISPATCHED', 'PARTIAL_DELIVERED'))::int AS ready_for_dispatch,
          COUNT(*) FILTER (WHERE status IN ('DISPATCHED', 'PARTIAL_DISPATCHED', 'PARTIAL_DELIVERED'))::int             AS dispatched,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int              AS completed
        FROM orders
      `),

      this.dataSource.query<Record<string, string>[]>(`
        SELECT
          COALESCE(SUM(total_amount),   0)::numeric AS total_revenue,
          COALESCE(SUM(pending_amount), 0)::numeric AS total_outstanding
        FROM orders
        WHERE status NOT IN ('CANCELLED', 'REJECTED')
      `),

      // Today's collection from the payments table — accurate even if order cached
      // columns are stale.
      this.dataSource.query<Record<string, string>[]>(`
        SELECT COALESCE(SUM(amount), 0)::numeric AS today_collection
        FROM payments
        WHERE created_at::date = CURRENT_DATE
      `),

      this.dataSource.query<Record<string, string>[]>(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('PENDING', 'IN_PROGRESS'))::int                     AS active_jobs,
          COUNT(*) FILTER (WHERE status = 'DONE' AND completed_at::date = CURRENT_DATE)::int    AS jobs_completed_today
        FROM production_jobs
      `),
    ]);

    const o = orderRows[0]  ?? {};
    const r = revenueRows[0] ?? {};
    const t = todayRows[0]  ?? {};
    const j = jobRows[0]    ?? {};

    let manufacturing_intel: DashboardSummary['manufacturing_intel'];
    try {
      manufacturing_intel = await this.manufacturingAnalytics.getIntelSummary();
    } catch {
      manufacturing_intel = undefined;
    }

    let finance_ops: DashboardSummary['finance_ops'];
    try {
      finance_ops = await this.financeOps.getDashboardSummary();
    } catch {
      finance_ops = undefined;
    }

    return {
      orders: {
        total_orders:       Number(o.total_orders       ?? 0),
        in_production:      Number(o.in_production      ?? 0),
        ready_for_dispatch: Number(o.ready_for_dispatch ?? 0),
        dispatched:         Number(o.dispatched         ?? 0),
        completed:          Number(o.completed          ?? 0),
      },
      payments: {
        total_revenue:     Number(r.total_revenue     ?? 0),
        total_outstanding: Number(r.total_outstanding ?? 0),
        today_collection:  Number(t.today_collection  ?? 0),
      },
      production: {
        active_jobs:          Number(j.active_jobs          ?? 0),
        jobs_completed_today: Number(j.jobs_completed_today ?? 0),
      },
      manufacturing_intel,
      finance_ops,
    };
  }
}

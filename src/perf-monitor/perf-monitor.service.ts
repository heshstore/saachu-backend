import { AsyncLocalStorage } from 'async_hooks';

// ─── Request context (set by interceptor, read by logger) ───────────────────
export interface RequestContext {
  endpoint: string;
  queryCount: number;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

// ─── Capacity constants ───────────────────────────────────────────────────────
const MAX_ENDPOINTS = 300; // bounded by route template count
const MAX_SLOW_RECORDS = 200; // ring buffer — slow query log
const MAX_SLOW_DURATIONS = 1000; // ring buffer — p95/p99 source
const MAX_EP_SAMPLES = 200; // per-endpoint latency ring buffer
const MAX_SQL_PATTERNS = 100; // top normalized SQL patterns
const MAX_TABLES = 50; // top tables by query count

// ─── Internal shapes ─────────────────────────────────────────────────────────
interface RollingBucket {
  queries: number;
  errors: number;
}

interface EndpointStat {
  count: number;
  totalMs: number;
  totalQueries: number;
  samples: number[];
  samplesHead: number;
  samplesFull: boolean;
}

interface SqlPatternStat {
  count: number;
  slowCount: number;
  totalSlowMs: number;
  lastSeen: string;
}

export interface SlowQueryRecord {
  ts: string;
  durationMs: number;
  context: string;
  pattern: string;
}

// ─── SQL normalization helpers ───────────────────────────────────────────────
// Pure functions — no I/O, no allocations beyond string ops.

function normalizeSql(sql: string): string {
  return sql
    .replace(/\$\d+/g, '?') // PostgreSQL $1 $2 → ?
    .replace(/'[^']*'/g, "'?'") // string literals
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s,)']*/g, '?') // timestamps
    .replace(/\b\d+\b/g, '?') // numeric literals
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim()
    .substring(0, 180); // hard length cap
}

function extractTableName(sql: string): string {
  // Try primary table: FROM "table", UPDATE "table", INSERT INTO "table"
  const m =
    sql.match(/\bFROM\s+"?([a-z_][a-z0-9_]*)"?/i) ??
    sql.match(/\bJOIN\s+"?([a-z_][a-z0-9_]*)"?/i) ??
    sql.match(/\bINTO\s+"?([a-z_][a-z0-9_]*)"?/i) ??
    sql.match(/\bUPDATE\s+"?([a-z_][a-z0-9_]*)"?/i) ??
    sql.match(/\bDELETE\s+FROM\s+"?([a-z_][a-z0-9_]*)"?/i);
  return m ? m[1].toLowerCase() : 'unknown';
}

// ─── Fixed-size ring buffer helpers — O(1), no shift(), no grow ──────────────

function rbPush<T>(
  buf: T[],
  head: { v: number },
  full: { v: boolean },
  max: number,
  item: T,
): void {
  buf[head.v] = item;
  head.v = (head.v + 1) % max;
  if (!full.v && head.v === 0) full.v = true;
}

function rbToArray<T>(buf: T[], head: number, full: boolean): T[] {
  if (!full) return buf.slice(0, head);
  return [...buf.slice(head), ...buf.slice(0, head)];
}

// ─── PerfMonitorService ───────────────────────────────────────────────────────
// Pure in-memory. Zero DB access. Zero scheduled jobs.
// All public methods are synchronous and complete in < 5 µs.
export class PerfMonitorService {
  private readonly _bootAt = Date.now();

  // Aggregate DB counters
  private _totalQueries = 0;
  private _totalErrors = 0;
  private _totalSlowQueries = 0;
  private _bgQueries = 0;

  // Rolling per-minute buckets [0..59]
  private readonly _minBuckets: RollingBucket[] = Array.from(
    { length: 60 },
    () => ({ queries: 0, errors: 0 }),
  );
  private _lastMinute = new Date().getMinutes();

  // Rolling per-hour buckets [0..23]
  private readonly _hrBuckets: RollingBucket[] = Array.from(
    { length: 24 },
    () => ({ queries: 0, errors: 0 }),
  );
  private _lastHour = new Date().getHours();

  // Slow query ring buffer — fixed size, O(1) insert
  private readonly _slowBuf: SlowQueryRecord[] = Array.from(
    { length: MAX_SLOW_RECORDS },
    () => ({ ts: '', durationMs: 0, context: '', pattern: '' }),
  );
  private readonly _slowHead = { v: 0 };
  private readonly _slowFull = { v: false };

  // Slow duration ring buffer for percentile calculation
  private readonly _durBuf: number[] = Array.from(
    { length: MAX_SLOW_DURATIONS },
    () => 0,
  );
  private readonly _durHead = { v: 0 };
  private readonly _durFull = { v: false };

  // Per-endpoint stats — bounded at MAX_ENDPOINTS distinct route templates
  private readonly _endpoints = new Map<string, EndpointStat>();

  // Top SQL patterns (normalized) — bounded at MAX_SQL_PATTERNS
  private readonly _sqlPatterns = new Map<string, SqlPatternStat>();

  // Table hit counts — bounded at MAX_TABLES
  private readonly _tables = new Map<string, number>();

  // ── Called by PerfMonitorLogger on every query ───────────────────────────
  recordQuery(sql: string): void {
    this._totalQueries++;
    const ctx = requestContext.getStore();
    if (ctx) {
      ctx.queryCount++;
    } else {
      this._bgQueries++;
    }
    this._rotate();
    const m = new Date().getMinutes();
    const h = new Date().getHours();
    this._minBuckets[m].queries++;
    this._hrBuckets[h].queries++;

    // SQL pattern tracking
    const pattern = normalizeSql(sql);
    let ps = this._sqlPatterns.get(pattern);
    if (!ps) {
      if (this._sqlPatterns.size >= MAX_SQL_PATTERNS) {
        // Evict the least-used pattern when at capacity
        let minKey = '';
        let minCount = Infinity;
        for (const [k, v] of this._sqlPatterns) {
          if (v.count < minCount) {
            minCount = v.count;
            minKey = k;
          }
        }
        if (minKey) this._sqlPatterns.delete(minKey);
      }
      ps = { count: 0, slowCount: 0, totalSlowMs: 0, lastSeen: '' };
      this._sqlPatterns.set(pattern, ps);
    }
    ps.count++;
    ps.lastSeen = new Date().toISOString();

    // Table hit tracking
    const table = extractTableName(sql);
    if (table !== 'unknown') {
      const current = this._tables.get(table) ?? 0;
      if (current === 0 && this._tables.size >= MAX_TABLES) {
        // Evict least-used table
        let minTable = '';
        let minCount = Infinity;
        for (const [k, v] of this._tables) {
          if (v < minCount) {
            minCount = v;
            minTable = k;
          }
        }
        if (minTable) this._tables.delete(minTable);
      }
      this._tables.set(table, (this._tables.get(table) ?? 0) + 1);
    }
  }

  // ── Called by PerfMonitorLogger when query exceeds slow threshold ─────────
  recordSlowQuery(durationMs: number, sql: string): void {
    this._totalSlowQueries++;
    const ctx = requestContext.getStore();
    const pattern = normalizeSql(sql);

    const rec: SlowQueryRecord = {
      ts: new Date().toISOString(),
      durationMs,
      context: ctx?.endpoint ?? 'background',
      pattern,
    };
    rbPush(
      this._slowBuf,
      this._slowHead,
      this._slowFull,
      MAX_SLOW_RECORDS,
      rec,
    );
    rbPush(
      this._durBuf,
      this._durHead,
      this._durFull,
      MAX_SLOW_DURATIONS,
      durationMs,
    );

    // Annotate the SQL pattern with slow stats
    const ps = this._sqlPatterns.get(pattern);
    if (ps) {
      ps.slowCount++;
      ps.totalSlowMs += durationMs;
    }
  }

  // ── Called by PerfMonitorLogger on query error ───────────────────────────
  recordQueryError(): void {
    this._totalErrors++;
    this._rotate();
    const m = new Date().getMinutes();
    const h = new Date().getHours();
    this._minBuckets[m].errors++;
    this._hrBuckets[h].errors++;
  }

  // ── Called by PerfMonitorInterceptor on HTTP request completion ───────────
  // endpoint is always a route TEMPLATE (e.g. GET /orders/:id), never an actual path.
  recordRequest(
    endpoint: string,
    durationMs: number,
    queryCount: number,
  ): void {
    let s = this._endpoints.get(endpoint);
    if (!s) {
      if (this._endpoints.size >= MAX_ENDPOINTS) return;
      s = {
        count: 0,
        totalMs: 0,
        totalQueries: 0,
        samples: Array.from({ length: MAX_EP_SAMPLES }, () => 0),
        samplesHead: 0,
        samplesFull: false,
      };
      this._endpoints.set(endpoint, s);
    }
    s.count++;
    s.totalMs += durationMs;
    s.totalQueries += queryCount;
    s.samples[s.samplesHead] = durationMs;
    s.samplesHead = (s.samplesHead + 1) % MAX_EP_SAMPLES;
    if (!s.samplesFull && s.samplesHead === 0) s.samplesFull = true;
  }

  // ── Full snapshot served by the controller ───────────────────────────────
  getSnapshot() {
    const now = Date.now();

    const qPerMin = this._minBuckets.reduce((a, b) => a + b.queries, 0) / 60;
    const qPerHour = this._hrBuckets.reduce((a, b) => a + b.queries, 0);
    const errPerHour = this._hrBuckets.reduce((a, b) => a + b.errors, 0);

    const durArr = rbToArray(this._durBuf, this._durHead.v, this._durFull.v);
    const avgSlowMs = durArr.length
      ? Math.round(durArr.reduce((a, b) => a + b, 0) / durArr.length)
      : 0;
    const p95Slow = this._percentile(durArr, 95);
    const p99Slow = this._percentile(durArr, 99);

    const endpoints = [...this._endpoints.entries()]
      .map(([endpoint, s]) => {
        const sArr = rbToArray(s.samples, s.samplesHead, s.samplesFull);
        return {
          endpoint,
          count: s.count,
          avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
          p95: this._percentile(sArr, 95),
          p99: this._percentile(sArr, 99),
          avgQueries: s.count ? +(s.totalQueries / s.count).toFixed(1) : 0,
          totalMs: s.totalMs,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const sqlPatterns = [...this._sqlPatterns.entries()]
      .map(([pattern, s]) => ({
        pattern,
        count: s.count,
        slowCount: s.slowCount,
        avgSlowMs: s.slowCount ? Math.round(s.totalSlowMs / s.slowCount) : 0,
        lastSeen: s.lastSeen,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const tables = [...this._tables.entries()]
      .map(([table, count]) => ({ table, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const score = this._score(qPerMin, avgSlowMs, this._totalErrors);
    const suggestions = this._suggestions(qPerMin, avgSlowMs, endpoints);

    const slowLog = rbToArray(this._slowBuf, this._slowHead.v, this._slowFull.v)
      .reverse()
      .slice(0, 50);

    // Compute pressure: bg queries as % of total, weighted by rate
    const bgPct = this._totalQueries
      ? Math.round((this._bgQueries / this._totalQueries) * 100)
      : 0;
    const pressureLabel =
      qPerMin > 300
        ? 'Critical'
        : qPerMin > 150
          ? 'High'
          : qPerMin > 50
            ? 'Medium'
            : 'Low';

    return {
      meta: {
        uptimeMs: now - this._bootAt,
        bootAt: new Date(this._bootAt).toISOString(),
        snapshotAt: new Date(now).toISOString(),
        endpointCount: this._endpoints.size,
        endpointCap: MAX_ENDPOINTS,
      },
      db: {
        totalQueries: this._totalQueries,
        totalErrors: this._totalErrors,
        totalSlowQueries: this._totalSlowQueries,
        backgroundQueries: this._bgQueries,
        backgroundPct: bgPct,
        queriesPerMinute: +qPerMin.toFixed(1),
        queriesPerHour: qPerHour,
        errorsPerHour: errPerHour,
        avgSlowMs,
        p95SlowMs: p95Slow,
        p99SlowMs: p99Slow,
        minBuckets: this._minBuckets,
        hrBuckets: this._hrBuckets,
        pressureLabel,
      },
      api: { endpoints },
      sql: { patterns: sqlPatterns },
      tables: { topTables: tables },
      slowQueries: slowLog,
      score,
      suggestions,
    };
  }

  private _rotate(): void {
    const m = new Date().getMinutes();
    const h = new Date().getHours();
    if (m !== this._lastMinute) {
      this._minBuckets[m] = { queries: 0, errors: 0 };
      this._lastMinute = m;
    }
    if (h !== this._lastHour) {
      this._hrBuckets[h] = { queries: 0, errors: 0 };
      this._lastHour = h;
    }
  }

  private _percentile(arr: number[], p: number): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  }

  private _score(
    qPerMin: number,
    avgSlowMs: number,
    totalErrors: number,
  ): { db: number; api: number; overall: number } {
    let db = 100;
    if (qPerMin > 50) db -= 10;
    if (qPerMin > 150) db -= 20;
    if (qPerMin > 300) db -= 20;
    if (avgSlowMs > 300) db -= 15;
    if (avgSlowMs > 800) db -= 15;
    if (totalErrors > 5) db -= 10;
    if (totalErrors > 50) db -= 10;
    db = Math.max(0, db);

    const eps = [...this._endpoints.values()];
    let api = 100;
    if (eps.length) {
      const avgApiMs =
        eps.reduce((a, s) => a + (s.count ? s.totalMs / s.count : 0), 0) /
        eps.length;
      if (avgApiMs > 300) api -= 15;
      if (avgApiMs > 600) api -= 20;
      if (avgApiMs > 1200) api -= 20;
    }

    return { db, api, overall: Math.round(db * 0.6 + api * 0.4) };
  }

  private _suggestions(
    qPerMin: number,
    avgSlowMs: number,
    endpoints: ReturnType<
      PerfMonitorService['getSnapshot']
    >['api']['endpoints'],
  ): object[] {
    const out: object[] = [];

    if (qPerMin > 100) {
      out.push({
        problem: 'High background query rate',
        evidence: `${qPerMin.toFixed(0)} queries/min — likely scheduler polling`,
        estimatedImprovement: '50–80% query reduction via idle backoff',
        risk: 'Low',
        filesLikelyAffected: ['sender/sender.service.ts'],
        rollbackComplexity: 'Low',
      });
    }

    if (avgSlowMs > 300) {
      out.push({
        problem: 'Elevated slow query duration',
        evidence: `Average slow query: ${avgSlowMs}ms`,
        estimatedImprovement: 'Add targeted index or cache hot read',
        risk: 'Low',
        filesLikelyAffected: ['See Slow Queries section for exact context'],
        rollbackComplexity: 'Low — indexes are reversible',
      });
    }

    for (const ep of endpoints.filter((e) => e.avgQueries > 5).slice(0, 3)) {
      out.push({
        problem: `N+1 risk on ${ep.endpoint}`,
        evidence: `${ep.avgQueries} queries/request over ${ep.count} calls`,
        estimatedImprovement:
          'Use eager load or cache to reduce queries/request',
        risk: 'Medium',
        filesLikelyAffected: [`Service/controller for ${ep.endpoint}`],
        rollbackComplexity: 'Medium',
      });
    }

    return out;
  }
}

// Module-level singleton — created before NestJS DI so the TypeORM logger
// can hold a reference without going through the DI container.
export const perfMonitorInstance = new PerfMonitorService();

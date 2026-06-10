/**
 * Authoritative WhatsApp marketing metrics — single source of truth.
 *
 * Delivery lifecycle → whatsapp_message_logs
 * Pending queue      → whatsapp_message_queue (pending count only)
 * Replied            → whatsapp_replies
 * Leads              → leads (source = WHATSAPP)
 */
import { DataSource } from 'typeorm';
import { getIstDayBounds } from '../shared/ist-time';

export type MetricScope = {
  numberId?: string;
  campaignId?: string;
};

export type AuthoritativeMetrics = {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  leads: number;
  failed: number;
  skipped: number;
  not_on_whatsapp: number;
  queue_pending: number;
  total: number;
};

export const METRIC_SOURCES = {
  SENT:            'whatsapp_message_logs — status IN (sent,delivered,read,replied), sent_at >= since',
  DELIVERED:       'whatsapp_message_logs — status IN (delivered,read,replied), sent_at >= since',
  READ:            'whatsapp_message_logs — status IN (read,replied), sent_at >= since',
  REPLIED:         'whatsapp_replies — received_at >= since',
  LEADS:           'leads — source=WHATSAPP, created_at >= since',
  FAILED:          'whatsapp_message_logs — status=failed, created_at >= since',
  SKIPPED:         'whatsapp_message_logs — status=skipped, NOT INVALID_WA_NUMBER, created_at >= since',
  NOT_ON_WHATSAPP: 'whatsapp_message_logs — status=skipped, INVALID_WA_NUMBER, created_at >= since',
  QUEUE_PENDING:   'whatsapp_message_queue — status=pending',
} as const;

export function startOfToday(): Date {
  return getIstDayBounds().start;
}

function scopeClause(
  scope: MetricScope | undefined,
  logAlias: string,
  params: unknown[],
): string {
  const parts: string[] = [];
  if (scope?.numberId) {
    params.push(scope.numberId);
    parts.push(`${logAlias}.number_id = $${params.length}`);
  }
  if (scope?.campaignId) {
    params.push(scope.campaignId);
    parts.push(`(${logAlias}.campaign_id = $${params.length} OR EXISTS (
      SELECT 1 FROM whatsapp_message_queue q_scope
      WHERE q_scope.id = ${logAlias}.queue_id AND q_scope.campaign_id = $${params.length}
    ))`);
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/** Fetch authoritative metrics for a time window (default: today). */
export async function fetchAuthoritativeMetrics(
  ds: DataSource,
  since: Date,
  scope?: MetricScope,
): Promise<AuthoritativeMetrics> {
  const params: unknown[] = [since];
  const logScope = scopeClause(scope, 'l', params);

  const row = await ds.query<{
    sent: string;
    delivered: string;
    read: string;
    failed: string;
    skipped_raw: string;
    not_on_whatsapp: string;
  }[]>(`
    SELECT
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.sent_at >= $1
          AND l.status IN ('sent','delivered','read','replied')${logScope}) AS sent,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.sent_at >= $1
          AND l.status IN ('delivered','read','replied')${logScope}) AS delivered,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.sent_at >= $1
          AND l.status IN ('read','replied')${logScope}) AS read,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.created_at >= $1
          AND l.status = 'failed'${logScope}) AS failed,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.created_at >= $1
          AND l.status = 'skipped'
          AND COALESCE(l.message_body, '') NOT ILIKE '%INVALID_WA_NUMBER%'
          AND COALESCE(l.message_body, '') NOT ILIKE '%NOT_ON_WHATSAPP%'${logScope}) AS skipped_raw,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs l
        WHERE l.created_at >= $1
          AND l.status = 'skipped'
          AND (
            COALESCE(l.message_body, '') ILIKE '%INVALID_WA_NUMBER%'
            OR COALESCE(l.message_body, '') ILIKE '%NOT_ON_WHATSAPP%'
          )${logScope}) AS not_on_whatsapp
  `, params).then(r => r[0] ?? {
    sent: '0', delivered: '0', read: '0', failed: '0', skipped_raw: '0', not_on_whatsapp: '0',
  });

  const replyParams: unknown[] = [since];
  let replyScope = '';
  if (scope?.numberId) {
    replyParams.push(scope.numberId);
    replyScope = ` AND r.number_id = $${replyParams.length}`;
  }
  if (scope?.campaignId) {
    replyParams.push(scope.campaignId);
    replyScope += ` AND EXISTS (
      SELECT 1 FROM whatsapp_message_logs l
      WHERE l.customer_phone = r.customer_phone
        AND l.number_id IS NOT DISTINCT FROM r.number_id
        AND l.sent_at >= $1
        AND (l.campaign_id = $${replyParams.length} OR EXISTS (
          SELECT 1 FROM whatsapp_message_queue q WHERE q.id = l.queue_id AND q.campaign_id = $${replyParams.length}
        ))
    )`;
  }
  const repliedRows = await ds.query<{ cnt: string }[]>(
    `SELECT COUNT(*)::int AS cnt FROM whatsapp_replies r
     WHERE r.received_at >= $1${replyScope}`,
    replyParams,
  );

  const leadParams: unknown[] = [since];
  let leadScope = '';
  if (scope?.numberId) {
    leadParams.push(scope.numberId);
    leadScope = ` AND EXISTS (
      SELECT 1 FROM whatsapp_replies wr
      WHERE wr.number_id = $${leadParams.length}
        AND wr.customer_phone = ld.phone
        AND wr.received_at >= $1
    )`;
  }
  if (scope?.campaignId) {
    leadParams.push(scope.campaignId);
    leadScope += ` AND EXISTS (
      SELECT 1 FROM whatsapp_message_logs l
      WHERE l.customer_phone = ld.phone
        AND l.sent_at >= $1
        AND (l.campaign_id = $${leadParams.length} OR EXISTS (
          SELECT 1 FROM whatsapp_message_queue q WHERE q.id = l.queue_id AND q.campaign_id = $${leadParams.length}
        ))
    )`;
  }
  const leadRows = await ds.query<{ cnt: string }[]>(
    `SELECT COUNT(*)::int AS cnt FROM leads ld
     WHERE ld.source = 'WHATSAPP' AND ld.created_at >= $1${leadScope}`,
    leadParams,
  );

  let queuePending = 0;
  const queueParams: unknown[] = [since];
  const queueWhere: string[] = [`q.status = 'pending'`, `q.created_at >= $1`];
  if (scope?.numberId) {
    queueParams.push(scope.numberId);
    queueWhere.push(`q.number_id = $${queueParams.length}`);
  }
  if (scope?.campaignId) {
    queueParams.push(scope.campaignId);
    queueWhere.push(`q.campaign_id = $${queueParams.length}`);
  }
  if (scope?.numberId || scope?.campaignId || !scope) {
    const qp = await ds.query<{ cnt: string }[]>(
      `SELECT COUNT(*)::int AS cnt FROM whatsapp_message_queue q
       WHERE ${queueWhere.join(' AND ')}`,
      queueParams,
    );
    queuePending = parseInt(qp[0]?.cnt ?? '0', 10);
  }

  const sent = parseInt(row.sent ?? '0', 10);
  const failed = parseInt(row.failed ?? '0', 10);
  const skipped = parseInt(row.skipped_raw ?? '0', 10);
  const notOnWhatsapp = parseInt(row.not_on_whatsapp ?? '0', 10);

  return {
    sent,
    delivered:       parseInt(row.delivered ?? '0', 10),
    read:            parseInt(row.read ?? '0', 10),
    replied:         parseInt(repliedRows[0]?.cnt ?? '0', 10),
    leads:           parseInt(leadRows[0]?.cnt ?? '0', 10),
    failed,
    skipped,
    not_on_whatsapp: notOnWhatsapp,
    queue_pending:   queuePending,
    total:           sent + failed + skipped + notOnWhatsapp,
  };
}

/**
 * Cumulative rollup from raw exclusive status counts (for campaign-scoped GROUP BY).
 * A row at READ also counts as DELIVERED and SENT.
 */
export function rollupCumulativeFromStatusRows(
  raw: Record<string, number>,
): Pick<AuthoritativeMetrics, 'sent' | 'delivered' | 'read' | 'replied' | 'failed' | 'skipped'> {
  const replied   = raw['replied']   ?? 0;
  const read      = (raw['read']     ?? 0) + replied;
  const delivered = (raw['delivered'] ?? 0) + read;
  const sent      = (raw['sent']     ?? 0) + delivered;
  return {
    sent,
    delivered,
    read,
    replied,
    failed:  raw['failed']  ?? 0,
    skipped: raw['skipped'] ?? 0,
  };
}

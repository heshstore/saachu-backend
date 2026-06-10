require('dotenv').config();
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const SKIP_REASONS = [
  'NOT_ON_WHATSAPP',
  'DUPLICATE_PHONE',
  'CUSTOMER_PROTECTED',
  'INVALID_NUMBER',
  'COOLDOWN_ACTIVE',
  'BLACKLISTED',
  'MISSING_REQUIRED_DATA',
  'UNKNOWN_ERROR',
];

function cleanUrl(url) {
  return (url || '')
    .replace(/([?&])channel_binding=require&?/i, '$1')
    .replace(/[?&]$/, '');
}

function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//***@${u.hostname}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

function sslOption(url) {
  return /neon\.tech|sslmode=require|ssl=true/i.test(url) ? { rejectUnauthorized: false } : false;
}

async function scalar(client, sql, params = []) {
  const rows = await client.query(sql, params);
  return rows.rows[0] || {};
}

async function main() {
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) throw new Error('DATABASE_URL missing');
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  const report = {
    target: redact(url),
    applied: APPLY,
    counts: {},
    findings: {},
    repairs: {},
  };

  report.counts.tables = await scalar(client, `
    SELECT
      (SELECT COUNT(*)::int FROM whatsapp_numbers) AS whatsapp_numbers,
      (SELECT COUNT(*)::int FROM marketing_campaigns) AS marketing_campaigns,
      (SELECT COUNT(*)::int FROM whatsapp_message_queue) AS queue_rows,
      (SELECT COUNT(*)::int FROM whatsapp_message_logs) AS message_logs,
      (SELECT COUNT(*)::int FROM whatsapp_replies) AS replies
  `);

  report.findings.numbers = (await client.query(`
    SELECT id, name, phone, status, is_active, wa_state, daily_sent, warmup_level, daily_limit,
           last_connected_at, last_message_sent_at
    FROM whatsapp_numbers
    ORDER BY created_at ASC
  `)).rows;

  report.findings.duplicate_pending_queue = (await client.query(`
    WITH ranked AS (
      SELECT
        id, campaign_id, number_id, customer_phone, template_id, status, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY DATE(created_at AT TIME ZONE 'Asia/Kolkata'), campaign_id, number_id, customer_phone, template_id
          ORDER BY created_at ASC, id ASC
        ) AS rn,
        COUNT(*) OVER (
          PARTITION BY DATE(created_at AT TIME ZONE 'Asia/Kolkata'), campaign_id, number_id, customer_phone, template_id
        ) AS dup_count
      FROM whatsapp_message_queue
      WHERE status = 'pending'
        AND created_at >= NOW() - INTERVAL '30 days'
    )
    SELECT * FROM ranked WHERE dup_count > 1 ORDER BY created_at DESC LIMIT 100
  `)).rows;

  report.findings.duplicate_campaign_days = (await client.query(`
    SELECT
      DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS ist_day,
      telecaller_number_id,
      COUNT(*)::int AS count,
      ARRAY_AGG(promo_id ORDER BY created_at) AS promo_ids
    FROM marketing_campaigns
    WHERE is_promotion = true AND telecaller_number_id IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
    ORDER BY ist_day DESC
    LIMIT 100
  `)).rows;

  report.findings.duplicate_message_logs = (await client.query(`
    SELECT queue_id, COUNT(*)::int AS count, ARRAY_AGG(id ORDER BY created_at) AS log_ids
    FROM whatsapp_message_logs
    WHERE queue_id IS NOT NULL
    GROUP BY queue_id
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 100
  `)).rows;

  report.findings.generic_skipped_queue = (await client.query(`
    SELECT COUNT(*)::int AS count
    FROM whatsapp_message_queue
    WHERE status = 'skipped'
      AND (error_message IS NULL OR error_message <> ALL($1::text[]))
  `, [SKIP_REASONS])).rows[0];

  report.findings.generic_skipped_logs = (await client.query(`
    SELECT COUNT(*)::int AS count
    FROM whatsapp_message_logs
    WHERE status = 'skipped'
      AND (message_body IS NULL OR message_body ILIKE 'SKIPPED:%' OR message_body = 'SKIPPED')
  `)).rows[0];

  report.findings.stale_wa_state = (await client.query(`
    SELECT id, phone, status, is_active, wa_state, updated_at
    FROM whatsapp_numbers
    WHERE wa_state IS NULL
       OR wa_state NOT IN ('idle','initializing','awaiting_scan','authenticating','ready','failed','disconnecting','awaiting_manual_reconnect')
       OR (wa_state = 'ready' AND updated_at < NOW() - INTERVAL '12 hours')
    ORDER BY updated_at ASC
  `)).rows;

  report.findings.auto_pause_records = await scalar(client, `
    SELECT COUNT(*)::int AS count, MAX(created_at) AS last_auto_pause
    FROM engine_audit_logs
    WHERE event = 'AUTO_PAUSE'
  `);

  report.findings.auto_paused_inactive_numbers = (await client.query(`
    SELECT n.id, n.phone, n.status, n.is_active, MAX(al.created_at) AS last_auto_pause_at
    FROM whatsapp_numbers n
    JOIN engine_audit_logs al ON al.number_id = n.id AND al.event = 'AUTO_PAUSE'
    WHERE n.is_active = false OR n.status = 'inactive'
    GROUP BY n.id, n.phone, n.status, n.is_active
    ORDER BY last_auto_pause_at DESC
  `)).rows;

  report.findings.today_capacity_by_number = (await client.query(`
    WITH today_queue AS (
      SELECT number_id, COUNT(*)::int AS queued_today
      FROM whatsapp_message_queue
      WHERE created_at >= (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
        AND number_id IS NOT NULL
      GROUP BY number_id
    )
    SELECT
      n.id, n.phone, n.name, n.status, n.is_active, n.wa_state, n.warmup_level, n.daily_sent,
      CASE n.warmup_level WHEN 1 THEN 20 WHEN 2 THEN 50 WHEN 3 THEN 100 WHEN 4 THEN 200 ELSE 20 END AS daily_cap,
      COALESCE(tq.queued_today, 0) AS queued_today,
      GREATEST(n.daily_sent, COALESCE(tq.queued_today, 0)) AS reserved_today,
      GREATEST(0, (CASE n.warmup_level WHEN 1 THEN 20 WHEN 2 THEN 50 WHEN 3 THEN 100 WHEN 4 THEN 200 ELSE 20 END) - GREATEST(n.daily_sent, COALESCE(tq.queued_today, 0))) AS remaining_today
    FROM whatsapp_numbers n
    LEFT JOIN today_queue tq ON tq.number_id = n.id
    WHERE n.is_active = true AND n.status = 'active'
    ORDER BY n.created_at ASC
  `)).rows;

  if (APPLY) {
    await client.query('BEGIN');
    try {
      report.repairs.duplicate_pending_queue = (await client.query(`
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY DATE(created_at AT TIME ZONE 'Asia/Kolkata'), campaign_id, number_id, customer_phone, template_id
              ORDER BY created_at ASC, id ASC
            ) AS rn,
            COUNT(*) OVER (
              PARTITION BY DATE(created_at AT TIME ZONE 'Asia/Kolkata'), campaign_id, number_id, customer_phone, template_id
            ) AS dup_count
          FROM whatsapp_message_queue
          WHERE status = 'pending'
            AND created_at >= NOW() - INTERVAL '30 days'
        )
        UPDATE whatsapp_message_queue q
        SET status = 'skipped', error_message = 'DUPLICATE_PHONE'
        FROM ranked r
        WHERE q.id = r.id AND r.dup_count > 1 AND r.rn > 1
        RETURNING q.id
      `)).rowCount;

      report.repairs.generic_skipped_queue = (await client.query(`
        UPDATE whatsapp_message_queue
        SET error_message = CASE
          WHEN COALESCE(error_message, '') ILIKE '%INVALID_WA_NUMBER%' OR COALESCE(error_message, '') ILIKE '%NOT_ON_WHATSAPP%' THEN 'NOT_ON_WHATSAPP'
          WHEN COALESCE(error_message, '') ILIKE '%DUPLICATE%' THEN 'DUPLICATE_PHONE'
          WHEN COALESCE(error_message, '') ILIKE '%TEST_MODE%' OR COALESCE(error_message, '') ILIKE '%PROTECTED%' THEN 'CUSTOMER_PROTECTED'
          WHEN COALESCE(error_message, '') ILIKE '%COOLDOWN%' OR COALESCE(error_message, '') ILIKE '%FINGERPRINT%' THEN 'COOLDOWN_ACTIVE'
          WHEN COALESCE(error_message, '') ILIKE '%BLACKLIST%' THEN 'BLACKLISTED'
          WHEN COALESCE(error_message, '') ILIKE '%NO USABLE%' OR COALESCE(error_message, '') ILIKE '%NO_BODY%' OR COALESCE(error_message, '') ILIKE '%MISSING%' THEN 'MISSING_REQUIRED_DATA'
          WHEN COALESCE(error_message, '') ILIKE '%INVALID%' THEN 'INVALID_NUMBER'
          ELSE 'UNKNOWN_ERROR'
        END
        WHERE status = 'skipped'
          AND (error_message IS NULL OR error_message <> ALL($1::text[]))
      `, [SKIP_REASONS])).rowCount;

      report.repairs.generic_skipped_logs = (await client.query(`
        UPDATE whatsapp_message_logs
        SET message_body = CASE
          WHEN COALESCE(message_body, '') ILIKE '%INVALID_WA_NUMBER%' THEN CONCAT('NOT_ON_WHATSAPP: ', COALESCE(message_body, ''))
          ELSE CONCAT('UNKNOWN_ERROR: ', COALESCE(message_body, ''))
        END
        WHERE status = 'skipped'
          AND (message_body IS NULL OR message_body ILIKE 'SKIPPED:%' OR message_body = 'SKIPPED')
      `)).rowCount;

      report.repairs.auto_paused_numbers_reactivated = (await client.query(`
        UPDATE whatsapp_numbers n
        SET is_active = true, status = 'active'
        WHERE (n.is_active = false OR n.status = 'inactive')
          AND EXISTS (
            SELECT 1 FROM engine_audit_logs al
            WHERE al.number_id = n.id AND al.event = 'AUTO_PAUSE'
          )
        RETURNING n.id
      `)).rowCount;

      report.repairs.daily_limits_normalized = (await client.query(`
        UPDATE whatsapp_numbers
        SET daily_limit = CASE warmup_level
          WHEN 1 THEN 20
          WHEN 2 THEN 50
          WHEN 3 THEN 100
          WHEN 4 THEN 200
          ELSE 20
        END
        WHERE daily_limit IS DISTINCT FROM CASE warmup_level
          WHEN 1 THEN 20
          WHEN 2 THEN 50
          WHEN 3 THEN 100
          WHEN 4 THEN 200
          ELSE 20
        END
        RETURNING id
      `)).rowCount;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await client.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Neon compute performance indexes
 *
 * Creates 3 targeted indexes to reduce per-query compute on the highest-frequency
 * cron scans. idx_lead_audit_lead_id is intentionally kept — it will be evaluated
 * via pg_stat_user_indexes after 7 days and dropped in a follow-up migration.
 *
 * Idempotent — safe to re-run.
 * No transaction wrapper — CONCURRENTLY is incompatible with explicit transactions.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function abortIfInvalidIndexes(client, names) {
  const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `SELECT indexname FROM pg_index
       JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      WHERE pg_class.relname IN (${placeholders})
        AND NOT pg_index.indisvalid`,
    names,
  );
  if (rows.length > 0) {
    console.error(
      `\n❌  The following indexes exist but are INVALID (left by a prior failed CONCURRENTLY build):\n` +
      rows.map(r => `     ${r.indexname}`).join('\n') +
      `\n\n   Drop them manually and re-run:\n` +
      rows.map(r => `     DROP INDEX CONCURRENTLY ${r.indexname};`).join('\n'),
    );
    process.exit(1);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('❌  DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('✅  Connected');

  // Pre-flight: abort if any target index is currently INVALID
  await abortIfInvalidIndexes(client, [
    'idx_job_status_due_date',
    'idx_leads_last_customer_reply',
    'idx_lead_audit_lead_action_created',
  ]);

  // ── 1. production_jobs(status, due_date) ──────────────────────────────────────
  // Covers checkDelayedJobs cron (288/day):
  //   WHERE status IN ('PENDING','IN_PROGRESS') AND due_date IS NOT NULL AND due_date < NOW()
  console.log('\n📌  idx_job_status_due_date …');
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_status_due_date
      ON production_jobs (status, due_date)
  `);
  console.log('   ✓ idx_job_status_due_date');

  // ── 2. leads(last_customer_reply_at) ─────────────────────────────────────────
  // Covers alertUnansweredCustomerReply cron (96/day):
  //   WHERE last_customer_reply_at > NOW() - INTERVAL '6 hours'
  //     AND last_customer_reply_at < NOW() - INTERVAL '30 minutes'
  console.log('\n📌  idx_leads_last_customer_reply …');
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_last_customer_reply
      ON leads (last_customer_reply_at)
  `);
  console.log('   ✓ idx_leads_last_customer_reply');

  // ── 3. lead_audit_logs(lead_id, action, created_at DESC) ─────────────────────
  // Covers:
  //   wasRecentlyEscalated(): WHERE lead_id = $1 AND action = 'ESCALATED' AND created_at > ...
  //   lead history (lead.service.ts:2637): WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100
  // The lead_id prefix also fully covers idx_lead_audit_lead_id (kept for now; reviewed at day 7).
  console.log('\n📌  idx_lead_audit_lead_action_created …');
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_audit_lead_action_created
      ON lead_audit_logs (lead_id, action, created_at DESC)
  `);
  console.log('   ✓ idx_lead_audit_lead_action_created');

  // ── 4. Verification ───────────────────────────────────────────────────────────
  // idx_lead_audit_lead_id is intentionally NOT dropped in this migration.
  // It will be verified via pg_stat_user_indexes after 7 days and removed separately.
  const { rows } = await client.query(`
    SELECT indexname, tablename
    FROM pg_indexes
    WHERE indexname IN (
      'idx_job_status_due_date',
      'idx_leads_last_customer_reply',
      'idx_lead_audit_lead_action_created'
    )
    ORDER BY tablename, indexname
  `);

  const present = new Set(rows.map(r => r.indexname));
  const check = (name, shouldExist) => {
    const exists = present.has(name);
    const ok = exists === shouldExist;
    const label = ok ? '✓' : '✗';
    const state = exists ? 'EXISTS' : 'ABSENT';
    const expectation = shouldExist ? 'EXISTS' : 'ABSENT';
    console.log(`  ${label} ${name}: ${state}  (expected: ${expectation})`);
    return ok;
  };

  console.log('\n── Index verification ────────────────────────────────────────');
  const allPass =
    check('idx_job_status_due_date',           true)  &
    check('idx_leads_last_customer_reply',      true)  &
    check('idx_lead_audit_lead_action_created', true);

  if (!allPass) {
    console.error('\n❌  One or more indexes are in an unexpected state — see above.');
    process.exit(1);
  }

  console.log('\n🎉  Migration complete — all indexes applied and verified.');
  await client.end();
}

main().catch((e) => { console.error('❌ ', e.message); process.exit(1); });

/* eslint-disable no-console */
/**
 * CRM Phase 20.1 — Startup Cleanup Migration
 *
 * Moves all one-time schema migrations and data backfills OUT of onModuleInit().
 * After running this script, onModuleInit() retains only the runtime safety check
 * (tags column probe).
 *
 * Idempotent — every statement uses IF NOT EXISTS / WHERE NULL guards.
 * Safe to run multiple times. Run once on each environment after deploying Phase 20.1.
 *
 * Usage:
 *   node scripts/migrate-crm-phase20-1-startup-cleanup.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function run(client, label, sql, params = []) {
  try {
    const result = await client.query(sql, params);
    const rowCount = result.rowCount ?? result.rows?.length ?? 0;
    if (rowCount > 0) console.log(`  ✓ ${label} — ${rowCount} row(s) affected`);
    else              console.log(`  · ${label} — no-op`);
    return rowCount;
  } catch (e) {
    console.error(`  ✗ ${label} FAILED: ${e.message}`);
    throw e;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('Connected. Running CRM Phase 20.1 startup cleanup migration…\n');

  try {
    // ── SECTION 1: Schema — column additions ──────────────────────────────────
    console.log('SECTION 1 — Schema column additions');

    await run(client, 'leads.is_phone_valid', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_phone_valid BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await run(client, 'leads.last_customer_reply_at', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_customer_reply_at TIMESTAMPTZ
    `);

    await run(client, 'leads.last_salesman_reply_at', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_salesman_reply_at TIMESTAMPTZ
    `);

    await run(client, 'leads.lead_quality', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_quality VARCHAR(20)
    `);
    await run(client, 'leads.quality_score', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS quality_score INT
    `);
    await run(client, 'idx_leads_quality', `
      CREATE INDEX IF NOT EXISTS idx_leads_quality ON leads(lead_quality)
    `);

    await run(client, 'leads.lead_ref', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_ref VARCHAR(20)
    `);
    await run(client, 'idx_leads_lead_ref', `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_lead_ref ON leads(lead_ref) WHERE lead_ref IS NOT NULL
    `);

    await run(client, 'leads.automation_snooze_until', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_snooze_until TIMESTAMPTZ
    `);
    await run(client, 'leads.automation_snooze_reason', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_snooze_reason TEXT
    `);

    await run(client, 'leads.workflow_state', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS workflow_state VARCHAR(30)
    `);
    await run(client, 'leads.last_outcome_type', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_outcome_type VARCHAR(20)
    `);
    await run(client, 'leads.last_objection_type', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_objection_type VARCHAR(30)
    `);
    await run(client, 'leads.call_attempt_count', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_attempt_count INT NOT NULL DEFAULT 0
    `);
    await run(client, 'leads.no_answer_count', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS no_answer_count INT NOT NULL DEFAULT 0
    `);
    await run(client, 'leads.last_contacted_at', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ
    `);
    await run(client, 'idx_leads_workflow_state', `
      CREATE INDEX IF NOT EXISTS idx_leads_workflow_state ON leads(workflow_state)
    `);

    await run(client, 'leads.next_action_due_at', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action_due_at TIMESTAMPTZ
    `);
    await run(client, 'leads.workflow_state_entered_at', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS workflow_state_entered_at TIMESTAMPTZ
    `);
    await run(client, 'leads.automation_manually_paused', `
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_manually_paused BOOLEAN NOT NULL DEFAULT false
    `);
    await run(client, 'idx_leads_next_action_due', `
      CREATE INDEX IF NOT EXISTS idx_leads_next_action_due ON leads(next_action_due_at) WHERE next_action_due_at IS NOT NULL
    `);

    await run(client, 'lead_audit_logs table', `
      CREATE TABLE IF NOT EXISTS lead_audit_logs (
        id          SERIAL PRIMARY KEY,
        lead_id     INT NOT NULL,
        user_id     INT NOT NULL,
        action      VARCHAR(50) NOT NULL,
        detail      TEXT,
        ip_address  VARCHAR(50),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── SECTION 2: Data backfills ─────────────────────────────────────────────
    console.log('\nSECTION 2 — Data backfills');

    await run(client, 'Backfill lead_quality + quality_score (WHERE NULL)', `
      UPDATE leads SET
        lead_quality = CASE
          WHEN duplicate_flag = true                                   THEN 'DUPLICATE'
          WHEN is_phone_valid = false AND phone IS NOT NULL            THEN 'AUTO_CAPTURED'
          WHEN phone IS NOT NULL AND email IS NOT NULL                 THEN 'QUALIFIED'
          WHEN phone IS NOT NULL OR email IS NOT NULL                  THEN 'PARTIAL'
          WHEN source IN ('WALK_IN','REFERRAL','EXHIBITION','FIELD_VISIT',
                          'OLD_CUSTOMER','DEALER_REFERENCE','BUSINESS_CARD',
                          'IMPORTED','DIRECT')                         THEN 'PARTIAL'
          WHEN product_interest IS NOT NULL                            THEN 'TRACKING_ONLY'
          ELSE 'JUNK'
        END,
        quality_score = CASE
          WHEN duplicate_flag = true                                                  THEN 20
          WHEN is_phone_valid = false AND phone IS NOT NULL                           THEN 15
          WHEN phone IS NOT NULL AND email IS NOT NULL AND source = 'OLD_CUSTOMER'   THEN 95
          WHEN phone IS NOT NULL AND email IS NOT NULL AND source = 'REFERRAL'       THEN 90
          WHEN phone IS NOT NULL AND email IS NOT NULL                               THEN 85
          WHEN phone IS NOT NULL AND source IN ('OLD_CUSTOMER','REFERRAL')           THEN 75
          WHEN phone IS NOT NULL                                                     THEN 60
          WHEN email IS NOT NULL AND source IN ('WALK_IN','REFERRAL','EXHIBITION',
               'FIELD_VISIT','OLD_CUSTOMER','DEALER_REFERENCE','BUSINESS_CARD',
               'IMPORTED','DIRECT')                                                  THEN 50
          WHEN email IS NOT NULL                                                     THEN 40
          WHEN source IN ('WALK_IN','REFERRAL','EXHIBITION','FIELD_VISIT',
               'OLD_CUSTOMER','DEALER_REFERENCE','BUSINESS_CARD','IMPORTED','DIRECT')
            AND product_interest IS NOT NULL                                         THEN 25
          WHEN source IN ('WALK_IN','REFERRAL','EXHIBITION','FIELD_VISIT',
               'OLD_CUSTOMER','DEALER_REFERENCE','BUSINESS_CARD','IMPORTED','DIRECT') THEN 20
          WHEN product_interest IS NOT NULL                                           THEN 10
          ELSE 5
        END
      WHERE lead_quality IS NULL
    `);

    await run(client, 'Archive orphan tracking-only leads (no identity, TRACKING_ONLY)', `
      UPDATE leads
      SET is_active = false,
          notes     = COALESCE(notes, '') || E'\n[Archived by Phase 20.1 migration: tracking-only, no identity]'
      WHERE lead_quality = 'TRACKING_ONLY'
        AND is_active = true
        AND (phone IS NULL OR TRIM(phone) = '')
        AND (email IS NULL OR TRIM(email) = '')
        AND created_at < NOW() - INTERVAL '30 days'
    `);

    await run(client, 'Archive operational leads with no identity', `
      UPDATE leads
      SET is_active         = false,
          workflow_state    = 'LOST',
          next_action_due_at = NULL,
          notes             = COALESCE(notes, '') || E'\n[Archived by Phase 20.1 migration: operational, no identity]'
      WHERE is_active = true
        AND (phone IS NULL OR TRIM(phone) = '')
        AND (email IS NULL OR TRIM(email) = '')
        AND lead_quality NOT IN ('TRACKING_ONLY', 'JUNK')
        AND source NOT IN ('WALK_IN','REFERRAL','EXHIBITION','FIELD_VISIT',
                           'OLD_CUSTOMER','DEALER_REFERENCE','BUSINESS_CARD',
                           'IMPORTED','DIRECT')
    `);

    await run(client, 'Backfill lead_ref (WHERE NULL)', `
      UPDATE leads
      SET lead_ref = CASE
        WHEN lead_quality IN ('TRACKING_ONLY', 'JUNK')
          AND (phone IS NULL OR TRIM(phone) = '')
          AND (email IS NULL OR TRIM(email) = '')
          THEN 'TRK-' || LPAD(id::text, 6, '0')
        ELSE 'LD-' || TO_CHAR(created_at, 'YYYY') || '-' || LPAD(id::text, 6, '0')
      END
      WHERE lead_ref IS NULL
    `);

    await run(client, 'Correct LD→TRK prefix on tracking/junk leads', `
      UPDATE leads SET lead_ref = 'TRK-' || LPAD(id::text, 6, '0')
      WHERE lead_quality IN ('TRACKING_ONLY', 'JUNK')
        AND (phone IS NULL OR TRIM(phone) = '')
        AND (email IS NULL OR TRIM(email) = '')
        AND lead_ref IS NOT NULL AND lead_ref NOT LIKE 'TRK-%'
    `);

    await run(client, 'Backfill workflow_state from status (WHERE NULL)', `
      UPDATE leads SET workflow_state = CASE
        WHEN status = 'NEW'        THEN 'FIRST_CALL'
        WHEN status = 'CONTACTED'  THEN 'FOLLOW_UP'
        WHEN status = 'INTERESTED' THEN 'SEND_QUOTATION'
        WHEN status = 'QUOTATION'  THEN 'CHASE_QUOTATION'
        WHEN status = 'CONVERTED'  THEN 'CONVERTED'
        WHEN status = 'LOST'       THEN 'LOST'
        ELSE 'FIRST_CALL'
      END
      WHERE workflow_state IS NULL
    `);

    await run(client, 'Backfill call_attempt_count / no_answer_count (WHERE 0)', `
      UPDATE leads l SET
        call_attempt_count = sub.total_calls,
        no_answer_count    = sub.no_answers,
        last_contacted_at  = sub.last_call_at
      FROM (
        SELECT
          lead_id,
          COUNT(*)                                       AS total_calls,
          COUNT(*) FILTER (WHERE note LIKE '📵%')       AS no_answers,
          MAX(created_at)                                AS last_call_at
        FROM lead_notes
        WHERE type = 'CALL'
        GROUP BY lead_id
      ) sub
      WHERE l.id = sub.lead_id
        AND l.call_attempt_count = 0
    `);

    await run(client, 'Backfill last_outcome_type from CALL note emoji (WHERE NULL)', `
      UPDATE leads l SET last_outcome_type = sub.otype
      FROM (
        SELECT DISTINCT ON (lead_id)
          lead_id,
          CASE
            WHEN note LIKE '✅%' THEN 'INTERESTED'
            WHEN note LIKE '📵%' THEN 'NO_ANSWER'
            WHEN note LIKE '⏰%' THEN 'LATER'
            WHEN note LIKE '❌%' THEN 'NOT_INTERESTED'
            ELSE NULL
          END AS otype
        FROM lead_notes
        WHERE type = 'CALL'
        ORDER BY lead_id, created_at DESC
      ) sub
      WHERE l.id = sub.lead_id
        AND l.last_outcome_type IS NULL
        AND sub.otype IS NOT NULL
    `);

    await run(client, 'Backfill workflow_state_entered_at (WHERE NULL)', `
      UPDATE leads
      SET workflow_state_entered_at = COALESCE(last_contacted_at, updated_at, created_at)
      WHERE workflow_state_entered_at IS NULL
    `);

    await run(client, 'Backfill next_action_due_at from workflow_state + SLA intervals (WHERE NULL)', `
      UPDATE leads SET next_action_due_at = CASE
        WHEN workflow_state = 'FIRST_CALL' AND source IN ('META','GOOGLE','WHATSAPP','SHOPIFY')
          THEN COALESCE(workflow_state_entered_at, created_at) + INTERVAL '1 hour'
        WHEN workflow_state = 'FIRST_CALL'
          THEN COALESCE(workflow_state_entered_at, created_at) + INTERVAL '4 hours'
        WHEN workflow_state = 'FOLLOW_UP'
          THEN COALESCE(
            NULLIF(follow_up_date, '1970-01-01'::timestamptz),
            COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '24 hours'
          )
        WHEN workflow_state = 'NO_ANSWER_1'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '8 hours'
        WHEN workflow_state = 'NO_ANSWER_2'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '24 hours'
        WHEN workflow_state = 'NO_ANSWER_ESC'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '48 hours'
        WHEN workflow_state = 'CALLBACK_WAIT'
          THEN COALESCE(
            NULLIF(follow_up_date, '1970-01-01'::timestamptz),
            COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '24 hours'
          )
        WHEN workflow_state = 'SEND_QUOTATION'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '2 hours'
        WHEN workflow_state = 'CHASE_QUOTATION'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '72 hours'
        WHEN workflow_state = 'NEGOTIATING'
          THEN COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '48 hours'
        WHEN workflow_state = 'NURTURE'
          THEN COALESCE(
            NULLIF(follow_up_date, '1970-01-01'::timestamptz),
            COALESCE(workflow_state_entered_at, NOW()) + INTERVAL '30 days'
          )
        ELSE NULL
      END
      WHERE next_action_due_at IS NULL
        AND workflow_state NOT IN ('CONVERTED', 'LOST')
    `);

    console.log('\n✅ Phase 20.1 startup cleanup migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

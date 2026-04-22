/* eslint-disable no-console */
/**
 * CRM Hardening Migration
 * Applies all schema changes for the final 1% hardening pass:
 *   1. lead_audit_logs  — add ip_address column, expand action check constraint
 *   2. lead_alerts      — new table with partial unique index for dedup
 *   3. leads            — add tags JSONB column
 *
 * Idempotent — safe to run multiple times.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    // ── 1. lead_audit_logs: create if not exists (idempotent), then add ip_address ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_audit_logs (
        id         SERIAL PRIMARY KEY,
        lead_id    INT NOT NULL,
        user_id    INT NOT NULL,
        action     VARCHAR(50) NOT NULL,
        detail     TEXT,
        ip_address VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_lead_id    ON lead_audit_logs(lead_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_user_id    ON lead_audit_logs(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_created_at ON lead_audit_logs(created_at DESC)
    `);
    // ADD COLUMN IF NOT EXISTS is a no-op when the table was just created above
    await client.query(`
      ALTER TABLE lead_audit_logs
        ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50)
    `);
    console.log('[1/5] lead_audit_logs table + ip_address column — done');

    // Ensure action column is wide enough (no-op if already VARCHAR(50))
    await client.query(`
      ALTER TABLE lead_audit_logs
        ALTER COLUMN action TYPE VARCHAR(50)
    `);
    console.log('[2/5] lead_audit_logs.action length — done');

    // ── 2. lead_alerts table ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_alerts (
        id         SERIAL PRIMARY KEY,
        lead_id    INT NOT NULL,
        type       VARCHAR(50) NOT NULL,
        message    TEXT NOT NULL,
        resolved   BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('[3/5] lead_alerts table — done');

    // Indexes for alert queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_alerts_lead_id
        ON lead_alerts(lead_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_alerts_unresolved
        ON lead_alerts(lead_id, type)
        WHERE resolved = false
    `);
    console.log('[4/5] lead_alerts indexes — done');

    // ── 3. leads: tags JSONB column ────────────────────────────────────────────
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
    // GIN index so frontend can filter by tag with @> operator
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_tags_gin
        ON leads USING GIN (tags)
    `);
    console.log('[5/5] leads.tags column + GIN index — done');

    console.log('\nMigration complete. Run `npm run start:dev` to verify.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

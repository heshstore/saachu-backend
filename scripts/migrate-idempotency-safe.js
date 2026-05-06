/* eslint-disable no-console */
/**
 * Migration: leads.idempotency_key + quotation table
 *
 * Live DB state at time of writing (2026-04-30):
 *   - leads.idempotency_key  → already exists (idempotent no-op)
 *   - uniq_leads_idempotency → already exists (idempotent no-op)
 *   - quotation table        → does NOT exist (will be created)
 *
 * Safe to re-run: every statement is guarded with IF NOT EXISTS.
 * Nothing is dropped or altered. All inside one transaction.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function step(client, label, sql) {
  await client.query(sql);
  console.log(`  ✓ ${label}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ── Step 1: leads.idempotency_key column ─────────────────────────────────
    // No-op if already exists (IF NOT EXISTS prevents any error).
    console.log('\n[1] leads.idempotency_key column');
    await step(client, 'ADD COLUMN IF NOT EXISTS leads.idempotency_key', `
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR;
    `);

    // ── Step 2: partial unique index on leads.idempotency_key ─────────────────
    // Partial (WHERE IS NOT NULL) so existing NULL rows never violate the constraint.
    // No-op if index already exists.
    console.log('\n[2] partial unique index on leads.idempotency_key');
    await step(client, 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_leads_idempotency', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_leads_idempotency
      ON leads (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    // ── Step 3: quotation table ───────────────────────────────────────────────
    // Full schema derived from quotation.entity.ts.
    // idempotency_key included in CREATE so ALTER in step 4 is always a no-op.
    console.log('\n[3] quotation table');
    await step(client, 'CREATE TABLE IF NOT EXISTS quotation', `
      CREATE TABLE IF NOT EXISTS quotation (
        id                   SERIAL         PRIMARY KEY,
        quotation_no         VARCHAR        UNIQUE,
        lead_id              INT,
        customer_id          INT,
        customer_name        VARCHAR,
        bill_to_id           INT,
        ship_to_id           INT,
        salesman_id          INT,
        status               VARCHAR        NOT NULL DEFAULT 'OPEN',
        validity_days        INT            NOT NULL DEFAULT 15,
        valid_till           DATE,
        delivery_by          VARCHAR,
        delivery_type        VARCHAR,
        payment_type         VARCHAR,
        delivery_instructions TEXT,
        charges_packing      DECIMAL(10,2)  NOT NULL DEFAULT 0,
        charges_cartage      DECIMAL(10,2)  NOT NULL DEFAULT 0,
        charges_forwarding   DECIMAL(10,2)  NOT NULL DEFAULT 0,
        charges_installation DECIMAL(10,2)  NOT NULL DEFAULT 0,
        charges_loading      DECIMAL(10,2)  NOT NULL DEFAULT 0,
        sub_total            DECIMAL(10,2)  NOT NULL DEFAULT 0,
        total_amount         DECIMAL(10,2)  NOT NULL DEFAULT 0,
        cancelled_at         TIMESTAMP,
        cancelled_by         INT,
        created_by           INT,
        is_wholesaler        BOOLEAN        NOT NULL DEFAULT FALSE,
        version              INT            NOT NULL DEFAULT 1,
        idempotency_key      VARCHAR,
        created_at           TIMESTAMP      NOT NULL DEFAULT now()
      );
    `);

    // ── Step 4: quotation_item table ──────────────────────────────────────────
    // Derived from quotation-item.entity.ts. References quotation(id) with CASCADE.
    console.log('\n[4] quotation_item table');
    await step(client, 'CREATE TABLE IF NOT EXISTS quotation_item', `
      CREATE TABLE IF NOT EXISTS quotation_item (
        id             SERIAL        PRIMARY KEY,
        quotation_id   INT           REFERENCES quotation(id) ON DELETE CASCADE,
        sku            VARCHAR,
        item_name      VARCHAR,
        instruction    TEXT,
        qty            DECIMAL(10,2) NOT NULL DEFAULT 1,
        rate           DECIMAL(10,2) NOT NULL DEFAULT 0,
        discount_type  VARCHAR       NOT NULL DEFAULT 'percent',
        discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
        gst_percent    DECIMAL(5,2)  NOT NULL DEFAULT 0,
        hsn_code       VARCHAR,
        amount         DECIMAL(10,2) NOT NULL DEFAULT 0
      );
    `);

    // ── Step 5: partial unique index on quotation.idempotency_key ────────────
    console.log('\n[5] partial unique index on quotation.idempotency_key');
    await step(client, 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotation_idempotency', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotation_idempotency
      ON quotation (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('\n✅  Migration complete\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌  Migration failed — rolled back. Reason:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();

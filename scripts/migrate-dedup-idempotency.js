/* eslint-disable no-console */
/**
 * Migration: customer dedup indexes + lead/quotation idempotency keys
 *
 * Fixes applied vs original MigrationInterface draft:
 *   - "lead"       → "leads"       (actual table name)
 *   - "gst"        → "gstNumber"   (actual customer column name)
 *   - quotation table created from scratch (does not exist in DB yet)
 *   - quotation_item table created from scratch
 *   - idempotency_key unique indexes use WHERE IS NOT NULL (partial)
 *     so existing NULL rows never violate the constraint
 *
 * Safe to re-run: every statement uses IF NOT EXISTS / IF EXISTS guards.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function run(client, label, sql) {
  try {
    await client.query(sql);
    console.log(`  ✓ ${label}`);
  } catch (e) {
    // "already exists" errors from IF NOT EXISTS guards are never thrown by PG,
    // but catch anything unexpected and surface it clearly.
    throw new Error(`${label}: ${e.message}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    await client.query('BEGIN');

    // ─────────────────────────────────────────────────────────────
    // 1. CREATE quotation table (does not exist in DB)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[1] quotation table');

    await run(client, 'CREATE quotation', `
      CREATE TABLE IF NOT EXISTS quotation (
        id                   SERIAL PRIMARY KEY,
        quotation_no         VARCHAR UNIQUE,
        lead_id              INT,
        customer_id          INT,
        customer_name        VARCHAR,
        bill_to_id           INT,
        ship_to_id           INT,
        salesman_id          INT,
        status               VARCHAR NOT NULL DEFAULT 'OPEN',
        validity_days        INT NOT NULL DEFAULT 15,
        valid_till           DATE,
        delivery_by          VARCHAR,
        delivery_type        VARCHAR,
        payment_type         VARCHAR,
        delivery_instructions TEXT,
        charges_packing      DECIMAL(10,2) NOT NULL DEFAULT 0,
        charges_cartage      DECIMAL(10,2) NOT NULL DEFAULT 0,
        charges_forwarding   DECIMAL(10,2) NOT NULL DEFAULT 0,
        charges_installation DECIMAL(10,2) NOT NULL DEFAULT 0,
        charges_loading      DECIMAL(10,2) NOT NULL DEFAULT 0,
        sub_total            DECIMAL(10,2) NOT NULL DEFAULT 0,
        total_amount         DECIMAL(10,2) NOT NULL DEFAULT 0,
        cancelled_at         TIMESTAMP,
        cancelled_by         INT,
        created_by           INT,
        is_wholesaler        BOOLEAN NOT NULL DEFAULT FALSE,
        version              INT NOT NULL DEFAULT 1,
        idempotency_key      VARCHAR,
        created_at           TIMESTAMP NOT NULL DEFAULT now()
      );
    `);

    // ─────────────────────────────────────────────────────────────
    // 2. CREATE quotation_item table
    // ─────────────────────────────────────────────────────────────
    console.log('\n[2] quotation_item table');

    await run(client, 'CREATE quotation_item', `
      CREATE TABLE IF NOT EXISTS quotation_item (
        id             SERIAL PRIMARY KEY,
        quotation_id   INT REFERENCES quotation(id) ON DELETE CASCADE,
        sku            VARCHAR,
        item_name      VARCHAR,
        instruction    TEXT,
        qty            DECIMAL(10,2) NOT NULL DEFAULT 1,
        rate           DECIMAL(10,2) NOT NULL DEFAULT 0,
        discount_type  VARCHAR NOT NULL DEFAULT 'percent',
        discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
        gst_percent    DECIMAL(5,2)  NOT NULL DEFAULT 0,
        hsn_code       VARCHAR,
        amount         DECIMAL(10,2) NOT NULL DEFAULT 0
      );
    `);

    // ─────────────────────────────────────────────────────────────
    // 3. CUSTOMER DEDUP — partial unique indexes (skip NULLs)
    //    Column names verified against live DB: mobile1, email, gstNumber
    // ─────────────────────────────────────────────────────────────
    console.log('\n[3] customer dedup indexes');

    await run(client, 'uniq_customer_mobile1', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_mobile1
      ON customer (mobile1)
      WHERE mobile1 IS NOT NULL;
    `);

    await run(client, 'uniq_customer_email', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_email
      ON customer (email)
      WHERE email IS NOT NULL;
    `);

    // NOTE: original draft used "gst" — actual column is "gstNumber"
    await run(client, 'uniq_customer_gst', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_gst
      ON customer ("gstNumber")
      WHERE "gstNumber" IS NOT NULL;
    `);

    // ─────────────────────────────────────────────────────────────
    // 4. LEAD IDEMPOTENCY
    //    NOTE: original draft used "lead" — actual table is "leads"
    // ─────────────────────────────────────────────────────────────
    console.log('\n[4] leads idempotency_key');

    await run(client, 'ADD leads.idempotency_key', `
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR;
    `);

    await run(client, 'uniq_lead_idempotency', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_lead_idempotency
      ON leads (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    // ─────────────────────────────────────────────────────────────
    // 5. QUOTATION IDEMPOTENCY (column already included in CREATE above;
    //    ADD COLUMN IF NOT EXISTS is still safe on a fresh table)
    // ─────────────────────────────────────────────────────────────
    console.log('\n[5] quotation idempotency_key');

    await run(client, 'ADD quotation.idempotency_key', `
      ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR;
    `);

    await run(client, 'uniq_quotation_idempotency', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotation_idempotency
      ON quotation (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('\n✅  Migration complete\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌  Migration failed (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();

/* eslint-disable no-console */
/**
 * Migration: orders idempotency + payments table
 *
 * What this does:
 *   1. Adds orders.idempotency_key (nullable VARCHAR, partial unique index)
 *   2. Creates payments table with dedup on payment_reference
 *
 * Safe to re-run — every statement uses IF NOT EXISTS guards.
 * Everything runs inside a single transaction.
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

    // ── 1. orders.idempotency_key ─────────────────────────────────────────────
    console.log('\n[1] orders.idempotency_key');

    await step(client, 'ADD COLUMN IF NOT EXISTS orders.idempotency_key', `
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR;
    `);

    // Partial index: NULLs are excluded so existing rows with no key never collide
    await step(client, 'CREATE UNIQUE INDEX uniq_orders_idempotency', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_idempotency
      ON orders (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    // ── 2. payments table ─────────────────────────────────────────────────────
    console.log('\n[2] payments table');

    await step(client, 'CREATE TABLE IF NOT EXISTS payments', `
      CREATE TABLE IF NOT EXISTS payments (
        id                 SERIAL         PRIMARY KEY,
        order_id           INT            NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        amount             DECIMAL(10,2)  NOT NULL,
        payment_mode       VARCHAR        NOT NULL DEFAULT 'cash',
        payment_reference  VARCHAR,
        notes              TEXT,
        created_by         INT,
        created_at         TIMESTAMP      NOT NULL DEFAULT now()
      );
    `);

    // Partial unique on payment_reference: two rows with NULL reference are allowed,
    // but two rows with the same non-null reference are rejected.
    await step(client, 'CREATE UNIQUE INDEX uniq_payments_reference', `
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_reference
      ON payments (payment_reference)
      WHERE payment_reference IS NOT NULL;
    `);

    // Fast lookup: all payments for a given order
    await step(client, 'CREATE INDEX idx_payments_order_id', `
      CREATE INDEX IF NOT EXISTS idx_payments_order_id
      ON payments (order_id);
    `);

    await client.query('COMMIT');
    console.log('\n✅  Migration complete\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌  Migration failed — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();

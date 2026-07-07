/* eslint-disable no-console */
/**
 * Adds Payment Terms columns to quotation/orders/invoice, a due-date column
 * used to compute Order.payment_due_date, a per-receivable WhatsApp reminder
 * dedup date, and a per-customer opt-out flag for the payment reminder cron.
 * Idempotent — safe to re-run.
 */
const { resolveScriptDb } = require('./lib/script-db');
const { Client } = require('pg');

async function run() {
  const { url, ssl } = resolveScriptDb();
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  console.log('Connected to database');

  await client.query(`
    ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(255),
      ADD COLUMN IF NOT EXISTS credit_days SMALLINT;
  `);
  console.log('✓ Columns quotation.payment_terms / credit_days ensured');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(255),
      ADD COLUMN IF NOT EXISTS credit_days SMALLINT,
      ADD COLUMN IF NOT EXISTS payment_due_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS is_wholesaler BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Columns orders.payment_terms / credit_days / payment_due_date / is_wholesaler ensured');

  await client.query(`
    ALTER TABLE invoice
      ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(255),
      ADD COLUMN IF NOT EXISTS credit_days SMALLINT,
      ADD COLUMN IF NOT EXISTS is_wholesaler BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Columns invoice.payment_terms / credit_days / is_wholesaler ensured');

  await client.query(`
    ALTER TABLE customer_receivables
      ADD COLUMN IF NOT EXISTS last_customer_reminder_sent DATE;
  `);
  console.log('✓ Column customer_receivables.last_customer_reminder_sent ensured');

  await client.query(`
    ALTER TABLE customer
      ADD COLUMN IF NOT EXISTS stop_payment_reminder BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column customer.stop_payment_reminder ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

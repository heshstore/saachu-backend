/* eslint-disable no-console */
/**
 * Adds advance_payment_date and advance_payment_mode to orders — captured
 * in the Send for Approval modal alongside advance_amount. This is metadata
 * describing the advance declared at that step (mirrors advance_amount /
 * process_without_advance, which are also plain order fields rather than
 * ledger entries) — separate from the Payment entity used by the actual
 * "Record Payment" flow. Idempotent — safe to re-run.
 */
const { resolveScriptDb } = require('./lib/script-db');
const { Client } = require('pg');

async function run() {
  const { url, ssl } = resolveScriptDb();
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  console.log('Connected to database');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS advance_payment_date DATE;
  `);
  console.log('✓ Column orders.advance_payment_date ensured');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS advance_payment_mode VARCHAR(50);
  `);
  console.log('✓ Column orders.advance_payment_mode ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

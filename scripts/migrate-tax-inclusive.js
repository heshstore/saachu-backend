/* eslint-disable no-console */
/**
 * Adds is_tax_inclusive BOOLEAN NOT NULL DEFAULT false to quotation and
 * orders — lets a document choose whether item rates are pre-tax (GST added
 * on top, the existing/default behavior) or already include GST (extracted
 * at calc time instead of added). Existing rows default to false (Extra
 * Tax), matching how every quotation/order was already being calculated.
 *
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
      ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column quotation.is_tax_inclusive ensured');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column orders.is_tax_inclusive ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

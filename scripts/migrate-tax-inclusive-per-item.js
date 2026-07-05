/* eslint-disable no-console */
/**
 * Adds is_tax_inclusive BOOLEAN NOT NULL DEFAULT false to quotation_item and
 * order_item — the document-level is_tax_inclusive column (migrate-tax-inclusive.js)
 * applied one tax mode to every line item, but the form lets each item be
 * entered as Extra or Inclusive independently. This gives each item its own
 * flag so mixed-mode documents calculate correctly. Existing rows default to
 * false (Extra Tax), matching how they were already calculated under the
 * document-level flag.
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
    ALTER TABLE quotation_item
      ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column quotation_item.is_tax_inclusive ensured');

  await client.query(`
    ALTER TABLE order_item
      ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('✓ Column order_item.is_tax_inclusive ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

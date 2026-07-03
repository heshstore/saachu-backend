/* eslint-disable no-console */
/**
 * Adds image_url TEXT NULL to quotation_item and order_item — snapshots the
 * item master's product photo at the time a quotation/order line item is
 * created, so the printed document can show the real product photo instead
 * of a placeholder.
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
      ADD COLUMN IF NOT EXISTS image_url TEXT NULL;
  `);
  console.log('✓ Column quotation_item.image_url ensured');

  await client.query(`
    ALTER TABLE order_item
      ADD COLUMN IF NOT EXISTS image_url TEXT NULL;
  `);
  console.log('✓ Column order_item.image_url ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

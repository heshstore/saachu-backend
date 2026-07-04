/* eslint-disable no-console */
/**
 * Adds unit TEXT NULL to quotation_item and order_item — snapshots the item
 * master's unit of measure (from the service-item / Shopify catalog master,
 * via ItemsService.findBySku) at the time a quotation/order line item is
 * created, so the printed document's UOM column is no longer blank.
 *
 * Mirrors migrate-item-photo.js (image_url on the same two tables).
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
      ADD COLUMN IF NOT EXISTS unit TEXT NULL;
  `);
  console.log('✓ Column quotation_item.unit ensured');

  await client.query(`
    ALTER TABLE order_item
      ADD COLUMN IF NOT EXISTS unit TEXT NULL;
  `);
  console.log('✓ Column order_item.unit ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

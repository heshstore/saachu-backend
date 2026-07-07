/* eslint-disable no-console */
/**
 * Adds the legacy orders.mobile / orders.order_number / order_item.itemName /
 * order_item.quantity / order_item.msp_price columns, matching production's
 * schema exactly. These predate the migration-script system (no script ever
 * created them — they were part of the very first orders table) so any dev
 * database bootstrapped after that point is missing them entirely.
 *
 * orders.service.ts's create() flow does a legacy-column sync UPDATE right
 * after every order/order_item insert (`UPDATE orders SET mobile = ...`,
 * `UPDATE order_item SET "itemName" = ...`) for older tooling that still
 * reads these columns — that UPDATE throws "column does not exist" on any
 * database missing them, breaking quotation→order conversion and direct
 * order creation entirely.
 *
 * Idempotent — safe to re-run (also safe against production, where these
 * columns already exist — IF NOT EXISTS is a no-op there).
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
      ADD COLUMN IF NOT EXISTS mobile        VARCHAR NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS order_number  VARCHAR NOT NULL DEFAULT '';
  `);
  console.log('✓ Columns orders.mobile / orders.order_number ensured');

  await client.query(`
    ALTER TABLE order_item
      ADD COLUMN IF NOT EXISTS "itemName"  VARCHAR NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS quantity    INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS msp_price   DOUBLE PRECISION NOT NULL DEFAULT 0;
  `);
  console.log('✓ Columns order_item.itemName / quantity / msp_price ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

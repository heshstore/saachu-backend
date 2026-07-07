/* eslint-disable no-console */
/**
 * Adds po_number and po_document_url to orders — captured either at direct
 * order creation or when converting a quotation to an order, and shown in
 * the Order Details panel. Idempotent — safe to re-run.
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
      ADD COLUMN IF NOT EXISTS po_number VARCHAR(255);
  `);
  console.log('✓ Column orders.po_number ensured');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS po_document_url VARCHAR(500);
  `);
  console.log('✓ Column orders.po_document_url ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

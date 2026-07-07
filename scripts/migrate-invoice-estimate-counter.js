/* eslint-disable no-console */
/**
 * Adds 'invoice' and 'estimate' rows to the existing document_no_counter
 * table (see migrate-document-no-counter.js) so invoices and estimates get
 * their own atomic, transaction-safe, independent sequences — Hs-00001 and
 * E-00001 — instead of sharing InvoiceService's old COUNT(*)+1 logic, which
 * let creating an estimate advance the number the next real invoice would
 * receive (and vice versa), and which raced under concurrent creates.
 *
 * Split invoices (production/trading billing company) are unified onto these
 * same two counters rather than keeping their separate PINV-/TINV- Postgres
 * sequences — see invoice.service.ts.
 *
 * Starts both counters at 0 (first number issued is 00001) since Hs-/E- is a
 * brand-new format with no prior numbers to continue from.
 *
 * Idempotent — safe to re-run (ON CONFLICT DO NOTHING keeps existing counts).
 */
const { resolveScriptDb } = require('./lib/script-db');
const { Client } = require('pg');

async function run() {
  const { url, ssl } = resolveScriptDb();
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  console.log('Connected to database');

  await client.query(`
    CREATE TABLE IF NOT EXISTS document_no_counter (
      name  VARCHAR(20) PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  console.log('✓ Table document_no_counter ensured');

  await client.query(
    `INSERT INTO document_no_counter (name, value) VALUES ('invoice', 0)
     ON CONFLICT (name) DO NOTHING`,
  );
  console.log('✓ invoice counter seeded at 0');

  await client.query(
    `INSERT INTO document_no_counter (name, value) VALUES ('estimate', 0)
     ON CONFLICT (name) DO NOTHING`,
  );
  console.log('✓ estimate counter seeded at 0');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

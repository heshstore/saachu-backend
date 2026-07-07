/* eslint-disable no-console */
/**
 * Adds round_off DECIMAL(10,2) NOT NULL DEFAULT 0 to quotation and orders.
 * total_amount is now rounded to the nearest rupee at save time; round_off is
 * the (possibly negative) adjustment applied to reach that rounded figure, so
 * the PDF/print "Rounded Off" line and the amount actually owed/collected
 * always agree with each other. Existing rows default to 0 (unrounded,
 * matching how they were already calculated/charged).
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
      ADD COLUMN IF NOT EXISTS round_off DECIMAL(10,2) NOT NULL DEFAULT 0;
  `);
  console.log('✓ Column quotation.round_off ensured');

  await client.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS round_off DECIMAL(10,2) NOT NULL DEFAULT 0;
  `);
  console.log('✓ Column orders.round_off ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

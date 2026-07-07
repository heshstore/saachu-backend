/* eslint-disable no-console */
/**
 * Adds sent_for_approval_at to orders — set when a salesperson sends an
 * order for manager approval (Order entity has carried this column since
 * the approval workflow was built, but no migration ever created it).
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
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS sent_for_approval_at TIMESTAMP;
  `);
  console.log('✓ Column orders.sent_for_approval_at ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Creates document_action_log — generic click-tracking for View / Edit /
 * Print / PDF / WhatsApp buttons across Quotation, Order, and Invoice
 * documents. (Email sends are already tracked separately in
 * transactional_email_logs.)
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
    CREATE TABLE IF NOT EXISTS document_action_log (
      id         SERIAL PRIMARY KEY,
      entity_type VARCHAR(20) NOT NULL,
      entity_id   INT NOT NULL,
      action      VARCHAR(20) NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log('✓ Table document_action_log ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_document_action_log_entity
      ON document_action_log(entity_type, entity_id, action)
  `);
  console.log('✓ Index idx_document_action_log_entity ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* eslint-disable no-console */
/**
 * Replaces the quotation_no_seq/order_no_seq Postgres SEQUENCEs with a plain
 * counter table, incremented inside the same DB transaction as the actual
 * save. Sequences are intentionally non-transactional in Postgres — nextval()
 * is never undone on rollback, so every failed/aborted create (a validation
 * error, a dropped request, etc.) permanently burns a number, producing gaps
 * like QUO0001, QUO0003, QUO0004, QUO0008. A counter table row, updated with
 * a normal (lockable, rollback-safe) UPDATE, closes that gap: a rolled-back
 * transaction gives the number back.
 *
 * Seeds each counter from the current sequence value so numbering continues
 * without collision or going backward — it does not reclaim already-burned
 * gaps, only prevents new ones going forward.
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

  const { rows: qRows } = await client.query(
    `SELECT last_value FROM quotation_no_seq`,
  );
  await client.query(
    `INSERT INTO document_no_counter (name, value) VALUES ('quotation', $1)
     ON CONFLICT (name) DO NOTHING`,
    [qRows[0].last_value],
  );
  console.log(`✓ quotation counter seeded at ${qRows[0].last_value}`);

  const { rows: oRows } = await client.query(
    `SELECT last_value FROM order_no_seq`,
  );
  await client.query(
    `INSERT INTO document_no_counter (name, value) VALUES ('order', $1)
     ON CONFLICT (name) DO NOTHING`,
    [oRows[0].last_value],
  );
  console.log(`✓ order counter seeded at ${oRows[0].last_value}`);

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

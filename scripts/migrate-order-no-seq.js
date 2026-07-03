/* eslint-disable no-console */
/**
 * Creates the order_no_seq PostgreSQL sequence used to generate
 * collision-free order numbers (ORD0001, ORD0002, …).
 *
 * Seeds from existing ORD-format numbers so the sequence never
 * re-issues a number already in the database.
 *
 * NOTE: migrate-orders-v2.js also creates this sequence but references
 * legacy columns (taxable_amount, order_number, itemName) that no longer
 * exist. That script cannot be run against the current schema.
 * This script is the safe replacement for the sequence-creation step only.
 *
 * Idempotent — safe to re-run.
 *
 * Run (local):  node scripts/migrate-order-no-seq.js
 * Run (prod):   NODE_ENV=production node scripts/migrate-order-no-seq.js
 */
const { resolveScriptDb } = require('./lib/script-db');
const { url: DB_URL, ssl: DB_SSL } = resolveScriptDb();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: DB_SSL });
  await client.connect();

  try {
    // 1. Create sequence if absent
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS order_no_seq
        START WITH 1
        INCREMENT BY 1
        NO CYCLE
    `);
    console.log('✓ order_no_seq ensured');

    // 2. Seed from existing ORD-format numbers
    //    Format: ORD followed by zero-padded digits (e.g. ORD0001 → suffix 1)
    //    Fall back to total row count so the sequence never re-issues a value.
    const { rows: fmtRows } = await client.query(`
      SELECT COALESCE(MAX(
        CASE WHEN order_no ~ '^ORD[0-9]+$'
             THEN LTRIM(substring(order_no FROM 4), '0')::BIGINT
             ELSE NULL END
      ), 0) AS max_no
      FROM orders
      WHERE order_no IS NOT NULL
    `);

    const { rows: cntRows } = await client.query(`
      SELECT COUNT(*) AS cnt FROM orders
    `);

    const seed = Math.max(
      Number(fmtRows[0].max_no) || 0,
      Number(cntRows[0].cnt) || 0,
    );

    console.log(
      `  orders rows: ${cntRows[0].cnt}, max ORD suffix: ${fmtRows[0].max_no}`,
    );

    if (seed > 0) {
      await client.query(`SELECT setval('order_no_seq', $1, true)`, [seed]);
      console.log(
        `  Sequence seeded to ${seed} — next value: ORD${String(seed + 1).padStart(4, '0')}`,
      );
    } else {
      console.log('  No existing orders — sequence starts at 1 (ORD0001)');
    }

    // 3. Verify
    const { rows: check } = await client.query(`
      SELECT sequencename, last_value
      FROM pg_sequences
      WHERE sequencename = 'order_no_seq'
    `);
    if (!check.length) {
      console.error('❌ order_no_seq not found after creation');
      process.exit(1);
    }
    console.log(
      `\n✅ order_no_seq present — last_value=${check[0].last_value}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

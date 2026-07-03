/* eslint-disable no-console */
/**
 * Creates the service_ticket_number_seq PostgreSQL sequence used by
 * after-sales.service.ts to generate collision-free ticket numbers
 * (ST-YYYY-000001 format).
 *
 * Seeds from the highest numeric suffix already in service_tickets
 * so no ticket number is ever reused.
 *
 * Idempotent — safe to re-run.
 *
 * Run (local):  node scripts/migrate-service-ticket-seq.js
 * Run (prod):   NODE_ENV=production node scripts/migrate-service-ticket-seq.js
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
      CREATE SEQUENCE IF NOT EXISTS service_ticket_number_seq
        START WITH 1
        INCREMENT BY 1
        NO CYCLE
    `);
    console.log('✓ service_ticket_number_seq ensured');

    // 2. Seed from existing ST-YYYY-NNNNNN numbers.
    //    Format: ST-<4-digit-year>-<6-digit-counter>
    //    Extract the counter (everything after the 8th character: "ST-YYYY-").
    //    Fall back to total row count as a safe floor.
    const { rows: fmtRows } = await client.query(`
      SELECT COALESCE(MAX(
        CASE WHEN ticket_number ~ '^ST-[0-9]{4}-[0-9]+$'
             THEN LTRIM(substring(ticket_number FROM 9), '0')::BIGINT
             ELSE NULL END
      ), 0) AS max_no
      FROM service_tickets
      WHERE ticket_number IS NOT NULL
    `);

    const { rows: cntRows } = await client.query(`
      SELECT COUNT(*) AS cnt FROM service_tickets
    `);

    const seed = Math.max(
      Number(fmtRows[0].max_no) || 0,
      Number(cntRows[0].cnt) || 0,
    );

    console.log(
      `  service_tickets rows: ${cntRows[0].cnt}, max ST suffix: ${fmtRows[0].max_no}`,
    );

    if (seed > 0) {
      await client.query(
        `SELECT setval('service_ticket_number_seq', $1, true)`,
        [seed],
      );
      console.log(
        `  Sequence seeded to ${seed} — next value: ST-${new Date().getFullYear()}-${String(seed + 1).padStart(6, '0')}`,
      );
    } else {
      console.log(
        `  No existing tickets — sequence starts at 1 (ST-${new Date().getFullYear()}-000001)`,
      );
    }

    // 3. Verify
    const { rows: check } = await client.query(`
      SELECT sequencename, last_value
      FROM pg_sequences
      WHERE sequencename = 'service_ticket_number_seq'
    `);
    if (!check.length) {
      console.error('❌ service_ticket_number_seq not found after creation');
      process.exit(1);
    }
    console.log(
      `\n✅ service_ticket_number_seq present — last_value=${check[0].last_value}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

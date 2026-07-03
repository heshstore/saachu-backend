/* eslint-disable no-console */
/**
 * Creates two PostgreSQL sequences used by invoice.service.ts
 * to generate collision-free split-billing invoice numbers:
 *
 *   production_invoice_no_seq → PINV-YYYY-0001 format
 *   trading_invoice_no_seq    → TINV-YYYY-0001 format
 *
 * Each sequence is seeded independently from its own existing invoice rows
 * (filtered by billing_company) so no invoice number is ever reused.
 *
 * Idempotent — safe to re-run.
 *
 * Run (local):  node scripts/migrate-invoice-seqs.js
 * Run (prod):   NODE_ENV=production node scripts/migrate-invoice-seqs.js
 */
const { resolveScriptDb } = require('./lib/script-db');
const { url: DB_URL, ssl: DB_SSL } = resolveScriptDb();
const { Client } = require('pg');

async function seedSeq(client, seqName, prefix, billingCompany) {
  // 1. Create sequence if absent
  await client.query(`
    CREATE SEQUENCE IF NOT EXISTS ${seqName}
      START WITH 1
      INCREMENT BY 1
      NO CYCLE
  `);
  console.log(`✓ ${seqName} ensured`);

  // 2. Seed from existing PINV/TINV invoice numbers for this billing company.
  //    Format: <PREFIX>-<4-digit-year>-<4-digit-counter>
  //    Counter starts after position: PREFIX length + dash + 4-digit year + dash
  //    e.g. "PINV-2026-0042" → prefix "PINV" (4 chars) + "-" + "2026" + "-" = 10 chars
  //    So counter starts at position 11.
  const prefixLen = prefix.length; // PINV=4, TINV=4
  const counterStart = prefixLen + 1 + 4 + 1 + 1; // prefix + '-' + year + '-', 1-indexed

  const { rows: fmtRows } = await client.query(
    `
    SELECT COALESCE(MAX(
      CASE WHEN invoice_no ~ $1
           THEN LTRIM(substring(invoice_no FROM $2), '0')::BIGINT
           ELSE NULL END
    ), 0) AS max_no
    FROM invoice
    WHERE billing_company = $3
      AND invoice_no IS NOT NULL
    `,
    [
      `^${prefix}-[0-9]{4}-[0-9]+$`,
      counterStart,
      billingCompany,
    ],
  );

  const { rows: cntRows } = await client.query(
    `SELECT COUNT(*) AS cnt FROM invoice WHERE billing_company = $1`,
    [billingCompany],
  );

  const seed = Math.max(
    Number(fmtRows[0].max_no) || 0,
    Number(cntRows[0].cnt) || 0,
  );

  console.log(
    `  ${billingCompany} invoice rows: ${cntRows[0].cnt}, max ${prefix} suffix: ${fmtRows[0].max_no}`,
  );

  if (seed > 0) {
    await client.query(`SELECT setval('${seqName}', $1, true)`, [seed]);
    const year = new Date().getFullYear();
    console.log(
      `  Sequence seeded to ${seed} — next value: ${prefix}-${year}-${String(seed + 1).padStart(4, '0')}`,
    );
  } else {
    const year = new Date().getFullYear();
    console.log(
      `  No existing ${billingCompany} invoices — sequence starts at 1 (${prefix}-${year}-0001)`,
    );
  }
}

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: DB_SSL });
  await client.connect();

  try {
    await seedSeq(
      client,
      'production_invoice_no_seq',
      'PINV',
      'PRODUCTION',
    );

    await seedSeq(
      client,
      'trading_invoice_no_seq',
      'TINV',
      'TRADING',
    );

    // Verify both exist
    const { rows: check } = await client.query(`
      SELECT sequencename, last_value
      FROM pg_sequences
      WHERE sequencename IN ('production_invoice_no_seq', 'trading_invoice_no_seq')
      ORDER BY sequencename
    `);

    if (check.length !== 2) {
      console.error(
        `❌ Expected 2 sequences, found ${check.length}`,
      );
      process.exit(1);
    }

    console.log('\nVerification:');
    check.forEach((r) =>
      console.log(
        `  ✓ ${r.sequencename} — last_value=${r.last_value}`,
      ),
    );

    console.log('\n✅ Invoice sequence migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

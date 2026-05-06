/* eslint-disable no-console */
/**
 * Creates the quotation_no_seq Postgres sequence used to generate
 * collision-free quotation numbers (QUO0001, QUO0002, …).
 *
 * Seeds the sequence from the current highest number already stored
 * so existing records are never overwritten.
 *
 * Idempotent — safe to re-run.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('Connected to database');

  // 1. Create sequence if it doesn't exist yet
  await client.query(`
    CREATE SEQUENCE IF NOT EXISTS quotation_no_seq
      START WITH 1
      INCREMENT BY 1
      NO CYCLE;
  `);
  console.log('✓ Sequence quotation_no_seq ensured');

  // 2. Seed the sequence from existing QUO-style numbers in the new QUONNNN format.
  //    For old year-based numbers (QUO-2026-0002), fall back to total row count
  //    so the new sequence never re-issues a number already in the DB.
  const { rows: newFmt } = await client.query(`
    SELECT COALESCE(MAX(
      CASE WHEN quotation_no ~ '^QUO[0-9]+$'
           THEN LTRIM(substring(quotation_no FROM 4), '0')::BIGINT
           ELSE NULL END
    ), 0) AS max_new
    FROM quotation
    WHERE quotation_no IS NOT NULL;
  `);

  const { rows: total } = await client.query(`
    SELECT COUNT(*) AS cnt FROM quotation;
  `);

  // Use whichever is larger: highest new-format number already issued, or total row count
  const seed = Math.max(Number(newFmt[0].max_new) || 0, Number(total[0].cnt) || 0);
  console.log(`  Existing quotation rows: ${total[0].cnt}, max new-format suffix: ${newFmt[0].max_new}`);

  if (seed > 0) {
    await client.query(`SELECT setval('quotation_no_seq', $1, true)`, [seed]);
    console.log(`  Sequence seeded to ${seed} — next value will be ${seed + 1}`);
  } else {
    console.log('  No existing quotations — sequence starts at 1');
  }

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

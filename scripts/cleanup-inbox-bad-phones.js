/**
 * cleanup-inbox-bad-phones.js
 *
 * Removes whatsapp_replies rows whose customer_phone contains a WhatsApp-internal
 * LID identifier instead of a real E.164 phone number, then backfills conversation_key
 * for all remaining rows that have it NULL.
 *
 * Root cause: @lid contacts' numeric identifiers (e.g. 199454170841150) were stored
 * instead of real phones (+919940172777) due to a bug in the phone resolution chain
 * that used contact.number without guarding against @lid JID types.
 *
 * Pattern that identifies WA internal identifiers stored as phones:
 *   "+1xxxxxxxxxxxxxxx"  — starts with "+1" but >12 chars  (US/Canada max is "+1XXXXXXXXXX" = 12)
 *   "+20xxxxxxxxxxxxxx"  — starts with "+20" but >13 chars (Egypt max is "+20XXXXXXXXXX" = 13)
 *
 * Additionally cleans any rows with invalid / missing phones (belt-and-suspenders).
 *
 * Run: node scripts/cleanup-inbox-bad-phones.js
 * Safe to run multiple times — idempotent.
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  try {
    await client.query('BEGIN');

    // ── 1. Preview what will be deleted ───────────────────────────────────────
    const preview = await client.query(`
      SELECT id, customer_phone, LENGTH(customer_phone) AS len, number_id, received_at
      FROM whatsapp_replies
      WHERE
        (customer_phone LIKE '+1%'  AND LENGTH(customer_phone) > 12)
        OR (customer_phone LIKE '+20%' AND LENGTH(customer_phone) > 13)
        OR customer_phone IS NULL
        OR customer_phone = ''
        OR customer_phone LIKE '%@%'
        OR customer_phone NOT LIKE '+%'
        OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) < 10
        OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) > 15
      ORDER BY received_at DESC
    `);

    if (preview.rows.length === 0) {
      console.log('✓ No bad rows found — nothing to delete.\n');
    } else {
      console.log(`Found ${preview.rows.length} bad row(s) to delete:\n`);
      for (const row of preview.rows) {
        console.log(`  id=${row.id} phone="${row.customer_phone}" len=${row.len} received_at=${row.received_at}`);
      }
      console.log('');
    }

    // ── 2. Delete bad rows ─────────────────────────────────────────────────────
    const del = await client.query(`
      DELETE FROM whatsapp_replies
      WHERE
        (customer_phone LIKE '+1%'  AND LENGTH(customer_phone) > 12)
        OR (customer_phone LIKE '+20%' AND LENGTH(customer_phone) > 13)
        OR customer_phone IS NULL
        OR customer_phone = ''
        OR customer_phone LIKE '%@%'
        OR customer_phone NOT LIKE '+%'
        OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) < 10
        OR LENGTH(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g')) > 15
    `);
    console.log(`Deleted ${del.rowCount} bad row(s).`);

    // ── 3. Backfill conversation_key for rows that have it NULL ───────────────
    const backfill = await client.query(`
      UPDATE whatsapp_replies
      SET conversation_key = customer_phone || '|' || COALESCE(number_id::text, '')
      WHERE conversation_key IS NULL
    `);
    console.log(`Backfilled conversation_key for ${backfill.rowCount} row(s).`);

    await client.query('COMMIT');
    console.log('\nCleanup complete.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nCleanup FAILED — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

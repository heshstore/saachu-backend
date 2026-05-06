/* eslint-disable no-console */
/**
 * Idempotency Migration
 *
 * Adds the idempotency_key column to the leads table and creates two supporting indexes:
 *
 *   leads.idempotency_key
 *     VARCHAR(64), nullable.  Populated on new leads; backfilled via UPDATE below.
 *
 *   idx_lead_idempotency
 *     Partial index — only indexes rows where idempotency_key IS NOT NULL.
 *     Keeps the index compact (anonymous / legacy rows are excluded).
 *
 *   idx_leads_phone_created_at
 *     Composite index on (phone, created_at DESC) for the 30-minute phone-based
 *     dedup query that runs on every lead creation.
 *
 * Backfill:
 *   Generates idempotency keys for existing leads that have a known phone,
 *   product_interest, and context so historical records participate in the
 *   24-hour dedup window immediately after migration.
 *
 * Idempotent — safe to run multiple times.
 * DDL uses CONCURRENTLY / IF NOT EXISTS / IF EXISTS so no table lock on live data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const crypto = require('crypto');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/** Must match generateIdempotencyKey() in lead.service.ts exactly. */
function buildKey(phone, productInterest, context) {
  const bare = (phone || '').replace(/\D/g, '').slice(-10);
  if (!bare || bare.length < 10) return null;
  const parts = [
    bare,
    (productInterest || '').toLowerCase().trim(),
    (context || '').toLowerCase().trim(),
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('❌  DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('✅  Connected to database');

  try {
    // ── 1. Add idempotency_key column ─────────────────────────────────────────
    console.log('\n📌  Adding leads.idempotency_key column…');
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64)
    `);
    console.log('   ✓ Column added (or already present)');

    // ── 2. Partial index on idempotency_key ───────────────────────────────────
    console.log('\n📌  Creating idx_lead_idempotency…');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_idempotency
        ON leads (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    console.log('   ✓ idx_lead_idempotency');

    // ── 3. Composite index for 30-min phone dedup query ───────────────────────
    console.log('\n📌  Creating idx_leads_phone_created_at…');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_phone_created_at
        ON leads (phone, created_at DESC)
        WHERE is_active = true AND phone IS NOT NULL
    `);
    console.log('   ✓ idx_leads_phone_created_at');

    // ── 4. Backfill idempotency_key for existing leads ────────────────────────
    console.log('\n📌  Backfilling idempotency_key for existing leads…');

    const { rows } = await client.query(`
      SELECT id, phone, product_interest, context
      FROM leads
      WHERE idempotency_key IS NULL
        AND phone IS NOT NULL
        AND phone <> 'unknown'
      ORDER BY id
    `);

    console.log(`   Found ${rows.length} leads to backfill`);

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const key = buildKey(row.phone, row.product_interest, row.context);
      if (!key) { skipped++; continue; }
      await client.query(
        `UPDATE leads SET idempotency_key = $1 WHERE id = $2`,
        [key, row.id],
      );
      updated++;
    }

    console.log(`   ✓ ${updated} rows backfilled, ${skipped} skipped (short/invalid phone)`);

    console.log('\n🎉  Migration complete.');
  } catch (err) {
    if (
      err.message?.includes('already exists') ||
      err.message?.includes('does not exist')
    ) {
      console.log(`   (skipped — ${err.message.trim()})`);
    } else {
      console.error('\n❌  Migration failed:', err.message);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

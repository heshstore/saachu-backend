/* eslint-disable no-console */
/**
 * Upgrades order idempotency from time-bucket string to SHA-256 content hash:
 *
 *   - Drops the UNIQUE constraint on idempotency_key (same business data can
 *     create multiple orders across separate time windows; uniqueness is enforced
 *     at the application layer via the 5-minute window check instead)
 *   - Creates a non-unique index idx_order_idempotency_key for fast lookup
 *   - Adds idempotency_created_at TIMESTAMPTZ NULL
 *   - Clears stale time-bucket keys so they don't interfere with hash-based lookup
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

  // 1. Drop unique constraint if it exists
  const { rows: constraints } = await client.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND contype = 'u'
      AND conname LIKE '%idempotency_key%'
  `);
  for (const { conname } of constraints) {
    await client.query(`ALTER TABLE orders DROP CONSTRAINT "${conname}"`);
    console.log(`✓ Dropped unique constraint: ${conname}`);
  }

  // Also drop any unique index TypeORM may have created separately
  const { rows: uqIdxs } = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'orders'
      AND indexname LIKE '%idempotency_key%'
      AND indexdef ILIKE '%unique%'
  `);
  for (const { indexname } of uqIdxs) {
    await client.query(`DROP INDEX IF EXISTS "${indexname}"`);
    console.log(`✓ Dropped unique index: ${indexname}`);
  }

  // 2. Create non-unique index for fast lookup
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_order_idempotency_key ON orders(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);
  console.log('✓ Index idx_order_idempotency_key ensured');

  // 3. Add idempotency_created_at column
  await client.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_created_at TIMESTAMPTZ NULL
  `);
  console.log('✓ Column idempotency_created_at ensured');

  // 4. Clear stale time-bucket keys (old format: ord_<id>_<id>_<bucket>)
  //    so they don't collide with new SHA-256 hex keys
  const { rowCount } = await client.query(`
    UPDATE orders SET idempotency_key = NULL, idempotency_created_at = NULL
    WHERE idempotency_key ~ '^ord_'
  `);
  console.log(`✓ Cleared ${rowCount} stale time-bucket idempotency keys`);

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

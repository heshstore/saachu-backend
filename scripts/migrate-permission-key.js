/* eslint-disable no-console */
/**
 * Safe migration for permission.key column.
 *
 * Problem:
 *   TypeORM synchronize tried to add NOT NULL + UNIQUE on permission.key but
 *   existing rows have NULL values → "column key contains null values" crash.
 *
 * What this script does (all in one transaction):
 *   1. Adds `key` column as nullable VARCHAR if it doesn't exist yet.
 *   2. Backfills any NULL rows with a deterministic default (perm_<id>).
 *   3. Sets the column NOT NULL.
 *   4. Adds a UNIQUE constraint if one doesn't already exist.
 *
 * Safe to re-run: every step is guarded with IF NOT EXISTS / NULL checks.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    await client.query('BEGIN');

    // 1. Add `key` column as nullable if it doesn't exist (idempotent)
    await client.query(`
      ALTER TABLE permission
      ADD COLUMN IF NOT EXISTS key VARCHAR;
    `);
    console.log('✓ Ensured permission.key column exists');

    // 2. Backfill any NULL keys with perm_<id>  (safe — won't clobber real values)
    const { rowCount } = await client.query(`
      UPDATE permission
      SET key = 'perm_' || id
      WHERE key IS NULL OR trim(key) = '';
    `);
    if (rowCount > 0) {
      console.log(`✓ Backfilled ${rowCount} row(s) with placeholder key`);
    } else {
      console.log('✓ No NULL keys found — nothing to backfill');
    }

    // 3. Set NOT NULL constraint (safe now that all rows have a value)
    await client.query(`
      ALTER TABLE permission
      ALTER COLUMN key SET NOT NULL;
    `);
    console.log('✓ Applied NOT NULL on permission.key');

    // 4. Add UNIQUE constraint only if it doesn't already exist
    const { rows } = await client.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'permission'::regclass
        AND contype = 'u'
        AND conname = 'UQ_permission_key';
    `);
    if (rows.length === 0) {
      await client.query(`
        ALTER TABLE permission
        ADD CONSTRAINT "UQ_permission_key" UNIQUE (key);
      `);
      console.log('✓ Added UNIQUE constraint on permission.key');
    } else {
      console.log('✓ UNIQUE constraint already exists — skipped');
    }

    // 5. Ensure quotation.lead_id column exists (safe — was previously managed by a
    //    synchronize hack that crashed when the table didn't exist yet)
    await client.query(`
      ALTER TABLE quotation
      ADD COLUMN IF NOT EXISTS lead_id INT;
    `);
    console.log('✓ Ensured quotation.lead_id column exists');

    await client.query('COMMIT');
    console.log('\n✅  Migration complete — permission.key is NOT NULL + UNIQUE; quotation.lead_id ensured');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌  Migration failed (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();

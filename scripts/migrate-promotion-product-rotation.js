/* eslint-disable no-console */
/**
 * Promotion Product Rotation Migration
 *
 * Creates the promotion_product_rotation table used by the AI Template Engine
 * to enforce per-telecaller product rotation with a 24-hour dedup window.
 *
 *   promotion_product_rotation
 *     id                    UUID PK
 *     telecaller_number_id  UUID    — WhatsApp number that sent the product
 *     product_id            INTEGER — shopify_catalog_items.id
 *     sku                   VARCHAR — denormalized; survives catalog renames
 *     campaign_id           UUID    — nullable; links to marketing_campaigns
 *     sent_at               TIMESTAMPTZ DEFAULT NOW()
 *
 * Indexes:
 *   idx_ppr_telecaller_sku      (telecaller_number_id, sku)      — 24h dedup check
 *   idx_ppr_telecaller_sent_at  (telecaller_number_id, sent_at)  — window expiry scan
 *
 * Idempotent — safe to run multiple times (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
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

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_product_rotation (
        id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        telecaller_number_id UUID        NOT NULL,
        product_id           INTEGER     NOT NULL,
        sku                  VARCHAR     NOT NULL,
        campaign_id          UUID,
        sent_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✓ promotion_product_rotation table');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ppr_telecaller_sku
        ON promotion_product_rotation (telecaller_number_id, sku)
    `);
    console.log('✓ idx_ppr_telecaller_sku');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ppr_telecaller_sent_at
        ON promotion_product_rotation (telecaller_number_id, sent_at)
    `);
    console.log('✓ idx_ppr_telecaller_sent_at');

    await client.query('COMMIT');
    console.log('\n✅ Migration complete — promotion_product_rotation table ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

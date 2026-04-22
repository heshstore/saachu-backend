/* eslint-disable no-console */
/**
 * migrate-leads-tracking.js
 *
 * Adds three columns that exist in the Lead entity but are missing from the DB:
 *   - lead_source_label  VARCHAR(50)   — origin label (e.g. "shopify", "inbound_message")
 *   - channel            VARCHAR(10)   — contact channel (WHATSAPP | FORM | CALL)
 *   - landing_page       TEXT          — page URL that triggered the Shopify lead
 *
 * Safe to re-run — all statements use IF NOT EXISTS.
 * No existing data is modified.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    console.log('Running leads tracking migration...\n');

    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS lead_source_label VARCHAR(50),
        ADD COLUMN IF NOT EXISTS channel            VARCHAR(10),
        ADD COLUMN IF NOT EXISTS landing_page       TEXT
    `);
    console.log('  ✓ lead_source_label, channel, landing_page added');

    // Optional index — channel is used in analytics GROUP BY queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads (channel)
    `);
    console.log('  ✓ index on channel');

    // Verify all 31 entity columns now exist
    const { rows } = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'leads'
      ORDER BY ordinal_position
    `);
    const cols = rows.map(r => r.column_name);
    const required = [
      'id','name','phone','email','city','state','country',
      'source','status','assigned_to','notes','follow_up_date',
      'product_interest','requirement_note','utm_source','utm_campaign',
      'lead_priority','customer_id','quotation_id','whatsapp_chat_id',
      'raw_payload','external_id','lead_source_label','channel',
      'landing_page','duplicate_flag','tags','is_active',
      'created_by','created_at','updated_at',
    ];
    const missing = required.filter(c => !cols.includes(c));
    if (missing.length) {
      console.error(`\n  ✗ Still missing after migration: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n  ✓ Verified: all ${required.length} required columns present`);
    console.log('\nMigration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

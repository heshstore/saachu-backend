/* eslint-disable no-console */
/**
 * Deactivate TRACKING_ONLY leads with no phone and no email.
 * Uses existing is_active + tags — same logic as LeadService.archiveOrphanTrackingLeads().
 *
 *   npm run archive:tracking-only-leads
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    const { rows } = await client.query(`
      UPDATE leads
      SET
        is_active = false,
        tags = CASE
          WHEN COALESCE(tags, '[]'::jsonb) ? 'archived_tracking_only' THEN tags
          ELSE COALESCE(tags, '[]'::jsonb) || '["archived_tracking_only"]'::jsonb
        END,
        notes = CASE
          WHEN notes IS NULL OR notes = '' THEN '[System] Archived: tracking-only record without contact identity.'
          WHEN notes NOT LIKE '%Archived: tracking-only%' THEN notes || E'\\n[System] Archived: tracking-only record without contact identity.'
          ELSE notes
        END,
        updated_at = NOW()
      WHERE is_active = true
        AND lead_quality = 'TRACKING_ONLY'
        AND (phone IS NULL OR TRIM(phone) = '' OR LOWER(TRIM(phone)) = 'unknown')
        AND (email IS NULL OR TRIM(email) = '')
      RETURNING id, name, source, product_interest, created_at
    `);

    console.log(`Archived ${rows.length} tracking-only lead(s) without contact identity.`);
    if (rows.length > 0 && rows.length <= 20) {
      for (const r of rows) {
        console.log(`  id=${r.id} source=${r.source} product=${r.product_interest ?? '-'} created=${r.created_at}`);
      }
    } else if (rows.length > 20) {
      console.log(`  (first 5 shown)`);
      rows.slice(0, 5).forEach((r) => {
        console.log(`  id=${r.id} source=${r.source} product=${r.product_interest ?? '-'}`);
      });
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

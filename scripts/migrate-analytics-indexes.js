/* eslint-disable no-console */
/**
 * Analytics Performance Indexes Migration
 * Adds targeted indexes on analytics_events to speed up aggregation queries.
 * Idempotent — safe to run multiple times.
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

const INDEXES = [
  {
    name: 'idx_analytics_event',
    sql:  `CREATE INDEX IF NOT EXISTS idx_analytics_event
             ON analytics_events(event)`,
  },
  {
    name: 'idx_analytics_product_event',
    sql:  `CREATE INDEX IF NOT EXISTS idx_analytics_product_event
             ON analytics_events(product, event)
             WHERE product IS NOT NULL`,
  },
  {
    name: 'idx_analytics_source',
    sql:  `CREATE INDEX IF NOT EXISTS idx_analytics_source
             ON analytics_events(source)`,
  },
  {
    name: 'idx_analytics_created_at',
    sql:  `CREATE INDEX IF NOT EXISTS idx_analytics_created_at
             ON analytics_events(created_at DESC)`,
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    for (const idx of INDEXES) {
      await client.query(idx.sql);
      console.log(`✅ ${idx.name}`);
    }

    // Verify
    const { rows } = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'analytics_events'
        AND indexname LIKE 'idx_analytics_%'
      ORDER BY indexname
    `);
    console.log(`\nIndexes on analytics_events (${rows.length} total):`);
    rows.forEach(r => console.log(`  ${r.indexname}`));

    console.log('\n✅ Analytics index migration complete.');
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });

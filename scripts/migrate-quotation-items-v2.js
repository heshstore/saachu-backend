/* eslint-disable no-console */
/**
 * quotation_item table v2
 *
 * Adds:
 *   - base_rate NUMERIC(10,2) DEFAULT 0  — item master price at time of quotation
 *   - quotation_id INT (explicit FK column alongside the TypeORM relation)
 *
 * base_rate stores the floor price from the item master so that:
 *   - historical audits see what the price was at quote time
 *   - the service can enforce rate >= base_rate at write time
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

  // 1. base_rate — floor price from item master
  await client.query(`
    ALTER TABLE quotation_item
      ADD COLUMN IF NOT EXISTS base_rate NUMERIC(10,2) NOT NULL DEFAULT 0;
  `);
  console.log('✓ Column base_rate ensured');

  // 2. quotation_id — TypeORM already created this column via the ManyToOne/JoinColumn
  //    relation with name: 'quotation_id'. Adding it here is a no-op on existing DBs;
  //    it protects fresh deployments where the relation column may not yet exist.
  await client.query(`
    ALTER TABLE quotation_item
      ADD COLUMN IF NOT EXISTS quotation_id INT;
  `);
  console.log('✓ Column quotation_id ensured');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

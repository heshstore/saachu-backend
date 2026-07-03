/**
 * LOCAL DEVELOPMENT ONLY — creates all missing tables in local PostgreSQL.
 * Uses TypeORM synchronize=true which is safe locally (creates missing tables/columns,
 * never drops existing data). DO NOT run against production.
 *
 * Usage: node scripts/local-db-init.js
 */
/* eslint-disable no-console */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const url = process.env.DATABASE_URL || '';
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
if (/neon\.tech|aiven\.io|supabase\.co/i.test(url)) {
  console.error('FATAL: DATABASE_URL points to a cloud database. This script is LOCAL ONLY.');
  process.exit(1);
}

const { DataSource } = require('typeorm');
const path = require('path');

const ds = new DataSource({
  type: 'postgres',
  url,
  ssl: false,
  synchronize: true,   // creates missing tables/columns — safe locally, never in production
  dropSchema: false,
  logging: ['error'],
  entities: [path.join(__dirname, '..', 'dist', '**', '*.entity.js')],
});

async function main() {
  console.log('Connecting to:', url.replace(/:([^@]+)@/, ':***@'));
  await ds.initialize();
  console.log('✅ Schema synchronized — all missing tables created.');
  const result = await ds.query(
    "SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'"
  );
  console.log('Total tables in local saachu:', result[0].n);
  await ds.destroy();
}

main().catch(e => {
  console.error('❌ Schema sync failed:', e.message);
  process.exit(1);
});

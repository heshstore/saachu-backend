/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_audit_logs (
        id         SERIAL PRIMARY KEY,
        lead_id    INT NOT NULL,
        user_id    INT NOT NULL,
        action     VARCHAR(50) NOT NULL,
        detail     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('Created lead_audit_logs table');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_lead_id ON lead_audit_logs(lead_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_user_id ON lead_audit_logs(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_audit_created_at ON lead_audit_logs(created_at DESC)
    `);
    console.log('Created indexes');

    console.log('Migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

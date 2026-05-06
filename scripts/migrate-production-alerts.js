require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_alerts (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id       INT         NOT NULL,
        alert_type   VARCHAR(20) NOT NULL,
        notified_to  INT         NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('production_alerts table created');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_job ON production_alerts (job_id);
    `);
    console.log('idx_alert_job index created');

    // Composite index prevents duplicate alert lookups being a full-scan.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_dedup
        ON production_alerts (job_id, notified_to, alert_type);
    `);
    console.log('idx_alert_dedup index created');

  } finally {
    await client.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });

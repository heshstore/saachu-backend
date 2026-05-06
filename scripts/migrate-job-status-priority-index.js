const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_job_status_priority ON production_jobs(status, priority)`,
    );
    console.log('✅ idx_job_status_priority created');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

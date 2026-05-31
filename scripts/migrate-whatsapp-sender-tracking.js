/* eslint-disable no-console */
/**
 * WhatsApp Sender Tracking Migration
 *
 * Adds three denormalized sender columns to whatsapp_message_queue so the
 * Queue Monitor can show WHICH telecaller number actually sent each message,
 * including failover cases where the pool selected a different number than
 * the one originally assigned at queue-build time.
 *
 *   actual_sender_number_id  UUID     — UUID of the WhatsApp number used
 *   actual_sender_phone      VARCHAR  — phone number, stored at send time
 *   actual_sender_name       VARCHAR  — display name, stored at send time
 *
 * All three are nullable; they are set by the sender service at the moment
 * a number is selected from the pool (before the actual WA send attempt).
 * Denormalized for historical stability — survives number renames/deletions.
 *
 * Idempotent — safe to run multiple times (ADD COLUMN IF NOT EXISTS).
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
      ALTER TABLE whatsapp_message_queue
        ADD COLUMN IF NOT EXISTS actual_sender_number_id UUID
    `);
    console.log('✓ whatsapp_message_queue.actual_sender_number_id');

    await client.query(`
      ALTER TABLE whatsapp_message_queue
        ADD COLUMN IF NOT EXISTS actual_sender_phone VARCHAR
    `);
    console.log('✓ whatsapp_message_queue.actual_sender_phone');

    await client.query(`
      ALTER TABLE whatsapp_message_queue
        ADD COLUMN IF NOT EXISTS actual_sender_name VARCHAR
    `);
    console.log('✓ whatsapp_message_queue.actual_sender_name');

    await client.query('COMMIT');
    console.log('\n✅ Migration complete — sender tracking columns added to whatsapp_message_queue');
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

/**
 * migrate-notifications-v2.js
 *
 * Drops the old notifications table (serial PK, legacy columns) and creates
 * the v2 schema (uuid PK, enums, priority, entity_type/id, is_active, expires_at).
 *
 * Safe to run on fresh installs. Existing notification rows are discarded
 * (they are ephemeral UI state, not business records).
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Drop existing table — notifications are transient UI state, no migration needed
    await client.query(`DROP TABLE IF EXISTS notifications CASCADE`);

    await client.query(`
      CREATE TABLE notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     INTEGER      NOT NULL,
        type        VARCHAR(12)  NOT NULL DEFAULT 'INFO',
        priority    VARCHAR(8)   NOT NULL DEFAULT 'MEDIUM',
        title       VARCHAR(255) NOT NULL,
        message     TEXT         NOT NULL,
        entity_type VARCHAR(30),
        entity_id   INTEGER,
        is_read     BOOLEAN      NOT NULL DEFAULT false,
        is_active   BOOLEAN      NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ
      )
    `);

    await client.query(`CREATE INDEX idx_notif_user_read   ON notifications (user_id, is_read)`);
    await client.query(`CREATE INDEX idx_notif_user_active ON notifications (user_id, is_active)`);
    await client.query(`CREATE INDEX idx_notif_created     ON notifications (created_at DESC)`);

    await client.query('COMMIT');
    console.log('✅ notifications v2 schema created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

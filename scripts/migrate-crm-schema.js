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
    console.log('Creating CRM tables...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(255) NOT NULL,
        phone            VARCHAR(10)  NOT NULL,
        email            VARCHAR(255),
        source           VARCHAR(20)  NOT NULL,
        status           VARCHAR(20)  NOT NULL DEFAULT 'NEW',
        assigned_to      INT REFERENCES "user"(id),
        notes            TEXT,
        follow_up_date   TIMESTAMPTZ,
        product_interest TEXT,
        utm_source       VARCHAR(255),
        utm_campaign     VARCHAR(255),
        lead_priority    VARCHAR(10)  NOT NULL DEFAULT 'MEDIUM',
        customer_id      INT REFERENCES customer(id),
        quotation_id     INT,
        whatsapp_chat_id VARCHAR(255),
        raw_payload      JSONB,
        external_id      VARCHAR(255),
        duplicate_flag   BOOLEAN NOT NULL DEFAULT false,
        is_active        BOOLEAN NOT NULL DEFAULT true,
        created_by       INT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('  ✓ leads');

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_id
        ON leads(external_id)
        WHERE external_id IS NOT NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_phone        ON leads(phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_assigned_to  ON leads(assigned_to)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_status       ON leads(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_created_at   ON leads(created_at)`);
    console.log('  ✓ leads indexes');

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_notes (
        id         SERIAL PRIMARY KEY,
        lead_id    INT NOT NULL REFERENCES leads(id),
        note       TEXT NOT NULL,
        type       VARCHAR(20) NOT NULL DEFAULT 'GENERAL',
        created_by INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id ON lead_notes(lead_id)`);
    console.log('  ✓ lead_notes');

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_followups (
        id           SERIAL PRIMARY KEY,
        lead_id      INT NOT NULL REFERENCES leads(id),
        due_date     TIMESTAMPTZ NOT NULL,
        note         TEXT,
        is_completed BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMPTZ,
        completed_by INT,
        created_by   INT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_followups_due
        ON lead_followups(due_date)
        WHERE is_completed = false
    `);
    console.log('  ✓ lead_followups');

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_settings (
        id         SERIAL PRIMARY KEY,
        key        VARCHAR(100) UNIQUE NOT NULL,
        value      TEXT,
        updated_at TIMESTAMPTZ
      )
    `);
    console.log('  ✓ crm_settings');

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id             SERIAL PRIMARY KEY,
        session_name   VARCHAR(100) UNIQUE NOT NULL,
        status         VARCHAR(20)  NOT NULL DEFAULT 'DISCONNECTED',
        qr_code        TEXT,
        phone_number   VARCHAR(20),
        connected_at   TIMESTAMPTZ,
        last_active_at TIMESTAMPTZ
      )
    `);
    console.log('  ✓ whatsapp_sessions');

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id        SERIAL PRIMARY KEY,
        chat_id   VARCHAR(255) NOT NULL,
        lead_id   INT REFERENCES leads(id),
        direction VARCHAR(10)  NOT NULL,
        body      TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        is_read   BOOLEAN NOT NULL DEFAULT false,
        sent_by   INT REFERENCES "user"(id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_chat   ON whatsapp_messages(chat_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_lead   ON whatsapp_messages(lead_id)`);
    console.log('  ✓ whatsapp_messages');

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        user_id    INT NOT NULL REFERENCES "user"(id),
        title      VARCHAR(255) NOT NULL,
        body       TEXT NOT NULL,
        type       VARCHAR(50)  NOT NULL DEFAULT 'lead_followup',
        ref_id     INT,
        is_read    BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`);
    console.log('  ✓ notifications');

    console.log('\nCRM schema migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

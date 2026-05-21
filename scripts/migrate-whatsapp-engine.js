/**
 * migrate-whatsapp-engine.js
 *
 * Creates all 7 WhatsApp Marketing Engine tables plus the engine_audit_logs table.
 * Idempotent — safe to re-run: uses CREATE TABLE IF NOT EXISTS.
 * Also adds template_id column to marketing_campaigns if it does not yet exist.
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  try {
    await client.query('BEGIN');

    // ── 1. whatsapp_numbers ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_numbers (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                  VARCHAR        NOT NULL,
        phone                 VARCHAR        NOT NULL UNIQUE,
        status                VARCHAR(20)    NOT NULL DEFAULT 'active',
        wa_state              VARCHAR(50),
        daily_limit           INT            NOT NULL DEFAULT 50,
        daily_sent            INT            NOT NULL DEFAULT 0,
        warmup_level          INT            NOT NULL DEFAULT 1,
        risk_score            DECIMAL(5,2)   NOT NULL DEFAULT 0,
        last_connected_at     TIMESTAMPTZ,
        last_message_sent_at  TIMESTAMPTZ,
        is_active             BOOLEAN        NOT NULL DEFAULT true,
        created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wn_status    ON whatsapp_numbers (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wn_is_active ON whatsapp_numbers (is_active)`);
    console.log('✓ whatsapp_numbers');

    // ── 2. marketing_templates ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_templates (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_name VARCHAR        NOT NULL UNIQUE,
        message_type  VARCHAR(20)    NOT NULL DEFAULT 'text',
        message_body  TEXT           NOT NULL,
        cta_type      VARCHAR(20)    NOT NULL DEFAULT 'none',
        cta_label     VARCHAR,
        cta_url       VARCHAR,
        media_type    VARCHAR,
        media_url     VARCHAR,
        is_active     BOOLEAN        NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mt_is_active ON marketing_templates (is_active)`);
    console.log('✓ marketing_templates');

    // ── 3. marketing_campaigns ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_campaigns (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_name       VARCHAR        NOT NULL,
        campaign_type       VARCHAR        NOT NULL DEFAULT 'broadcast',
        status              VARCHAR(20)    NOT NULL DEFAULT 'draft',
        daily_target        INT            NOT NULL DEFAULT 100,
        send_window_start   VARCHAR(10)    NOT NULL DEFAULT '09:00',
        send_window_end     VARCHAR(10)    NOT NULL DEFAULT '18:00',
        random_delay_min    INT            NOT NULL DEFAULT 30,
        random_delay_max    INT            NOT NULL DEFAULT 120,
        template_id         UUID,
        notes               TEXT,
        created_by          INT,
        created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mc_status     ON marketing_campaigns (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mc_created_by ON marketing_campaigns (created_by)`);
    console.log('✓ marketing_campaigns');

    // ── 4. marketing_audience ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_audience (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id         INT,
        phone               VARCHAR        NOT NULL UNIQUE,
        name                VARCHAR,
        city                VARCHAR,
        business_type       VARCHAR,
        source              VARCHAR,
        quality_score       DECIMAL(5,2)   NOT NULL DEFAULT 0,
        is_whatsapp_valid   BOOLEAN        NOT NULL DEFAULT true,
        opt_out             BOOLEAN        NOT NULL DEFAULT false,
        last_contacted_at   TIMESTAMPTZ,
        last_reply_at       TIMESTAMPTZ,
        reply_status        VARCHAR(20)    NOT NULL DEFAULT 'none',
        created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_customer_id ON marketing_audience (customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_opt_out     ON marketing_audience (opt_out)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_reply_status ON marketing_audience (reply_status)`);
    console.log('✓ marketing_audience');

    // ── 5. whatsapp_message_queue ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_queue (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id      UUID,
        number_id        UUID,
        customer_id      INT,
        product_id       INT,
        template_id      UUID,
        customer_phone   VARCHAR        NOT NULL,
        scheduled_at     TIMESTAMPTZ    NOT NULL,
        status           VARCHAR(20)    NOT NULL DEFAULT 'pending',
        attempt_count    INT            NOT NULL DEFAULT 0,
        priority         INT            NOT NULL DEFAULT 5,
        message_payload  JSONB,
        error_message    TEXT,
        sent_at          TIMESTAMPTZ,
        created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wmq_status             ON whatsapp_message_queue (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wmq_campaign_id        ON whatsapp_message_queue (campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wmq_scheduled_at       ON whatsapp_message_queue (scheduled_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wmq_customer_phone     ON whatsapp_message_queue (customer_phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wmq_status_scheduled   ON whatsapp_message_queue (status, scheduled_at)`);
    console.log('✓ whatsapp_message_queue');

    // ── 6. whatsapp_message_logs ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_logs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id     UUID,
        queue_id        UUID,
        number_id       UUID,
        customer_phone  VARCHAR        NOT NULL,
        message_type    VARCHAR(20)    NOT NULL DEFAULT 'text',
        message_body    TEXT,
        media_url       VARCHAR,
        wa_message_id   VARCHAR,
        status          VARCHAR(20)    NOT NULL DEFAULT 'sent',
        sent_at         TIMESTAMPTZ,
        delivered_at    TIMESTAMPTZ,
        read_at         TIMESTAMPTZ,
        reply_received  BOOLEAN        NOT NULL DEFAULT false,
        reply_message   TEXT,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wml_campaign_id    ON whatsapp_message_logs (campaign_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wml_customer_phone ON whatsapp_message_logs (customer_phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wml_wa_message_id  ON whatsapp_message_logs (wa_message_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wml_number_sent    ON whatsapp_message_logs (number_id, sent_at DESC)`);
    console.log('✓ whatsapp_message_logs');

    // ── 7. whatsapp_replies ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_replies (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        number_id        UUID,
        customer_phone   VARCHAR        NOT NULL,
        customer_name    VARCHAR,
        message          TEXT           NOT NULL,
        message_type     VARCHAR(20)    NOT NULL DEFAULT 'text',
        crm_lead_created BOOLEAN        NOT NULL DEFAULT false,
        crm_lead_id      INT,
        received_at      TIMESTAMPTZ    NOT NULL,
        created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wr_customer_phone   ON whatsapp_replies (customer_phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wr_crm_lead_created ON whatsapp_replies (crm_lead_created)`);
    console.log('✓ whatsapp_replies');

    // ── 8. engine_audit_logs (operational audit trail) ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS engine_audit_logs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event           VARCHAR(50)    NOT NULL,
        customer_phone  VARCHAR(20),
        number_id       UUID,
        template_id     UUID,
        campaign_id     UUID,
        score           DECIMAL(5,2),
        reason          TEXT,
        metadata        JSONB,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eal_event      ON engine_audit_logs (event)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eal_created_at ON engine_audit_logs (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eal_number_id  ON engine_audit_logs (number_id)`);
    console.log('✓ engine_audit_logs');

    await client.query('COMMIT');
    console.log('\n✅ WhatsApp Engine migration complete — 8 tables created/verified');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

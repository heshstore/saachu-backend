/**
 * migrate-whatsapp-engine-schema-final.js
 *
 * Comprehensive idempotent reconciliation of the WhatsApp Marketing Engine schema.
 * Covers all phases (1 through 9) in a single pass.
 *
 * Safe to run on any database state:
 *   - Tables that already exist are skipped (CREATE TABLE IF NOT EXISTS)
 *   - Columns that already exist are skipped (ADD COLUMN IF NOT EXISTS)
 *   - Indexes that already exist are skipped (CREATE INDEX IF NOT EXISTS)
 *
 * Run: node scripts/migrate-whatsapp-engine-schema-final.js
 */

const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  const added = [];
  const skipped = [];

  async function addColumnIfMissing(table, column, definition) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (rows.length > 0) {
      skipped.push(`${table}.${column}`);
      return;
    }
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    added.push(`${table}.${column}`);
    console.log(`  + added: ${table}.${column}`);
  }

  async function createIndexIfMissing(name, table, definition) {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [name],
    );
    if (rows.length > 0) {
      skipped.push(`index:${name}`);
      return;
    }
    await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${definition}`);
    added.push(`index:${name}`);
    console.log(`  + added: index ${name}`);
  }

  try {
    await client.query('BEGIN');

    // ── 1. whatsapp_numbers ────────────────────────────────────────────────────
    console.log('[ whatsapp_numbers ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_numbers (
        id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        name                  VARCHAR      NOT NULL,
        phone                 VARCHAR      NOT NULL UNIQUE,
        status                VARCHAR(20)  NOT NULL DEFAULT 'active',
        wa_state              VARCHAR(50),
        daily_limit           INT          NOT NULL DEFAULT 50,
        daily_sent            INT          NOT NULL DEFAULT 0,
        warmup_level          INT          NOT NULL DEFAULT 1,
        risk_score            DECIMAL(5,2) NOT NULL DEFAULT 0,
        last_connected_at     TIMESTAMPTZ,
        last_message_sent_at  TIMESTAMPTZ,
        is_active             BOOLEAN      NOT NULL DEFAULT true,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_wn_status',       'whatsapp_numbers', '(status)');
    await createIndexIfMissing('idx_wn_is_active',    'whatsapp_numbers', '(is_active)');
    await createIndexIfMissing('idx_wn_phone_unique', 'whatsapp_numbers', '(phone)');
    console.log('  ✓ whatsapp_numbers\n');

    // ── 2. marketing_templates ─────────────────────────────────────────────────
    console.log('[ marketing_templates ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_templates (
        id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        template_name      VARCHAR      NOT NULL UNIQUE,
        message_type       VARCHAR(20)  NOT NULL DEFAULT 'text',
        message_body       TEXT         NOT NULL,
        cta_type           VARCHAR(20)  NOT NULL DEFAULT 'none',
        cta_label          VARCHAR,
        cta_url            VARCHAR,
        media_type         VARCHAR,
        media_url          VARCHAR,
        is_active          BOOLEAN      NOT NULL DEFAULT true,
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    // Phase 7: performance weighting
    await addColumnIfMissing('marketing_templates', 'performance_weight',
      'DECIMAL(5,2) NOT NULL DEFAULT 1.0');
    // Phase 9: product category rotation
    await addColumnIfMissing('marketing_templates', 'product_category',
      'VARCHAR(100)');
    await createIndexIfMissing('idx_mt_is_active',        'marketing_templates', '(is_active)');
    await createIndexIfMissing('idx_mt_product_category', 'marketing_templates',
      '(product_category) WHERE product_category IS NOT NULL');
    console.log('  ✓ marketing_templates\n');

    // ── 3. marketing_campaigns ─────────────────────────────────────────────────
    console.log('[ marketing_campaigns ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_campaigns (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_name     VARCHAR      NOT NULL,
        campaign_type     VARCHAR      NOT NULL DEFAULT 'broadcast',
        status            VARCHAR(20)  NOT NULL DEFAULT 'draft',
        daily_target      INT          NOT NULL DEFAULT 100,
        send_window_start VARCHAR(10)  NOT NULL DEFAULT '09:00',
        send_window_end   VARCHAR(10)  NOT NULL DEFAULT '18:00',
        random_delay_min  INT          NOT NULL DEFAULT 30,
        random_delay_max  INT          NOT NULL DEFAULT 120,
        template_id       UUID,
        notes             TEXT,
        created_by        INT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_mc_status',     'marketing_campaigns', '(status)');
    await createIndexIfMissing('idx_mc_created_by', 'marketing_campaigns', '(created_by)');
    console.log('  ✓ marketing_campaigns\n');

    // ── 4. marketing_audience ─────────────────────────────────────────────────
    console.log('[ marketing_audience ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_audience (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id       INT,
        phone             VARCHAR      NOT NULL UNIQUE,
        name              VARCHAR,
        city              VARCHAR,
        business_type     VARCHAR,
        source            VARCHAR,
        quality_score     DECIMAL(5,2) NOT NULL DEFAULT 0,
        is_whatsapp_valid BOOLEAN      NOT NULL DEFAULT true,
        opt_out           BOOLEAN      NOT NULL DEFAULT false,
        last_contacted_at TIMESTAMPTZ,
        last_reply_at     TIMESTAMPTZ,
        reply_status      VARCHAR(20)  NOT NULL DEFAULT 'none',
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    // Phase 5: test contacts
    await addColumnIfMissing('marketing_audience', 'is_test_contact',
      'BOOLEAN NOT NULL DEFAULT FALSE');
    // Phase 7: smart cooldown
    await addColumnIfMissing('marketing_audience', 'cooldown_until',
      'TIMESTAMPTZ');
    // Phase 9: fatigue scoring
    await addColumnIfMissing('marketing_audience', 'fatigue_score',
      'DECIMAL(5,2) NOT NULL DEFAULT 0');

    await createIndexIfMissing('idx_ma_customer_id',    'marketing_audience', '(customer_id)');
    await createIndexIfMissing('idx_ma_opt_out',        'marketing_audience', '(opt_out)');
    await createIndexIfMissing('idx_ma_reply_status',   'marketing_audience', '(reply_status)');
    await createIndexIfMissing('idx_ma_phone_unique',   'marketing_audience', '(phone)');
    await createIndexIfMissing('idx_ma_test_contact',   'marketing_audience',
      '(is_test_contact) WHERE is_test_contact = TRUE');
    await createIndexIfMissing('idx_ma_cooldown_until', 'marketing_audience',
      '(cooldown_until) WHERE cooldown_until IS NOT NULL');
    await createIndexIfMissing('idx_ma_fatigue_score',  'marketing_audience',
      '(fatigue_score) WHERE fatigue_score > 0');
    console.log('  ✓ marketing_audience\n');

    // ── 5. whatsapp_message_queue ─────────────────────────────────────────────
    console.log('[ whatsapp_message_queue ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_queue (
        id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id      UUID,
        number_id        UUID,
        customer_id      INT,
        product_id       INT,
        template_id      UUID,
        customer_phone   VARCHAR      NOT NULL,
        scheduled_at     TIMESTAMPTZ  NOT NULL,
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        attempt_count    INT          NOT NULL DEFAULT 0,
        priority         INT          NOT NULL DEFAULT 5,
        message_payload  JSONB,
        error_message    TEXT,
        sent_at          TIMESTAMPTZ,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_wmq_status',             'whatsapp_message_queue', '(status)');
    await createIndexIfMissing('idx_wmq_campaign_id',        'whatsapp_message_queue', '(campaign_id)');
    await createIndexIfMissing('idx_wmq_scheduled_at',       'whatsapp_message_queue', '(scheduled_at)');
    await createIndexIfMissing('idx_wmq_customer_phone',     'whatsapp_message_queue', '(customer_phone)');
    await createIndexIfMissing('idx_wmq_status_scheduled_at','whatsapp_message_queue', '(status, scheduled_at)');
    console.log('  ✓ whatsapp_message_queue\n');

    // ── 6. whatsapp_message_logs ──────────────────────────────────────────────
    console.log('[ whatsapp_message_logs ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_logs (
        id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id    UUID,
        queue_id       UUID,
        number_id      UUID,
        customer_phone VARCHAR      NOT NULL,
        message_type   VARCHAR(20)  NOT NULL DEFAULT 'text',
        message_body   TEXT,
        media_url      VARCHAR,
        wa_message_id  VARCHAR,
        status         VARCHAR(20)  NOT NULL DEFAULT 'sent',
        sent_at        TIMESTAMPTZ,
        delivered_at   TIMESTAMPTZ,
        read_at        TIMESTAMPTZ,
        reply_received BOOLEAN      NOT NULL DEFAULT false,
        reply_message  TEXT,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_wml_campaign_id',    'whatsapp_message_logs', '(campaign_id)');
    await createIndexIfMissing('idx_wml_customer_phone', 'whatsapp_message_logs', '(customer_phone)');
    await createIndexIfMissing('idx_wml_wa_message_id',  'whatsapp_message_logs', '(wa_message_id)');
    await createIndexIfMissing('idx_wml_number_sent',    'whatsapp_message_logs', '(number_id, sent_at DESC)');
    console.log('  ✓ whatsapp_message_logs\n');

    // ── 7. whatsapp_replies ───────────────────────────────────────────────────
    console.log('[ whatsapp_replies ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_replies (
        id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        number_id        UUID,
        customer_phone   VARCHAR      NOT NULL,
        customer_name    VARCHAR,
        message          TEXT         NOT NULL,
        message_type     VARCHAR(20)  NOT NULL DEFAULT 'text',
        crm_lead_created BOOLEAN      NOT NULL DEFAULT false,
        crm_lead_id      INT,
        received_at      TIMESTAMPTZ  NOT NULL,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_wr_customer_phone',   'whatsapp_replies', '(customer_phone)');
    await createIndexIfMissing('idx_wr_crm_lead_created', 'whatsapp_replies', '(crm_lead_created)');
    console.log('  ✓ whatsapp_replies\n');

    // ── 8. engine_audit_logs ─────────────────────────────────────────────────
    console.log('[ engine_audit_logs ]');
    await client.query(`
      CREATE TABLE IF NOT EXISTS engine_audit_logs (
        id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        event          VARCHAR(50)  NOT NULL,
        customer_phone VARCHAR(20),
        number_id      UUID,
        template_id    UUID,
        campaign_id    UUID,
        score          DECIMAL(5,2),
        reason         TEXT,
        metadata       JSONB,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await createIndexIfMissing('idx_eal_event',      'engine_audit_logs', '(event)');
    await createIndexIfMissing('idx_eal_created_at', 'engine_audit_logs', '(created_at DESC)');
    await createIndexIfMissing('idx_eal_number_id',  'engine_audit_logs', '(number_id)');
    console.log('  ✓ engine_audit_logs\n');

    await client.query('COMMIT');

    console.log('─'.repeat(60));
    if (added.length > 0) {
      console.log(`\n✅ Schema reconciliation complete`);
      console.log(`   Added (${added.length}): ${added.join(', ')}`);
    } else {
      console.log('\n✅ Schema already up to date — nothing to add');
    }
    if (skipped.length > 0) {
      console.log(`   Already present (${skipped.length}): ${skipped.join(', ')}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

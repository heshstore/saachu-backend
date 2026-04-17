/* eslint-disable no-console */
/**
 * Full production migration: RBAC tables + CRM tables + permissions + Admin user.
 * Run once against the prod DB:
 *   node scripts/migrate-prod.js
 *
 * Safe to re-run (all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING).
 */
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const DB_URL = 'postgresql://neondb_owner:npg_hlAOPvN2r6po@ep-noisy-pond-a1nmenkk-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const ADMIN_MOBILE   = '9000000001';
const ADMIN_PASSWORD = 'Saachu@2026';
const ADMIN_NAME     = 'Admin';

// ─── Permission definitions ───────────────────────────────────────────────────
const PERMISSIONS = [
  // Customers
  { key: 'customer.view',        label: 'View Customers',          module: 'Customers' },
  { key: 'customer.create',      label: 'Create Customer',         module: 'Customers' },
  { key: 'customer.edit',        label: 'Edit Customer',           module: 'Customers' },
  { key: 'customer.delete',      label: 'Delete Customer',         module: 'Customers' },
  // Items
  { key: 'item.view',            label: 'View Items',              module: 'Items' },
  { key: 'item.create',          label: 'Create Item',             module: 'Items' },
  { key: 'item.edit',            label: 'Edit Item',               module: 'Items' },
  { key: 'item.shopify_sync',    label: 'Shopify Sync',            module: 'Items' },
  // Quotations
  { key: 'quotation.view',       label: 'View Quotations',         module: 'Quotations' },
  { key: 'quotation.create',     label: 'Create Quotation',        module: 'Quotations' },
  { key: 'quotation.edit',       label: 'Edit Quotation',          module: 'Quotations' },
  { key: 'quotation.cancel',     label: 'Cancel Quotation',        module: 'Quotations' },
  { key: 'quotation.convert',    label: 'Convert to Order',        module: 'Quotations' },
  // Orders
  { key: 'order.view',           label: 'View Orders',             module: 'Orders' },
  { key: 'order.create',         label: 'Create Order',            module: 'Orders' },
  { key: 'order.edit',           label: 'Edit Order',              module: 'Orders' },
  { key: 'order.cancel',         label: 'Cancel Order',            module: 'Orders' },
  { key: 'order.approve',        label: 'Approve Order',           module: 'Orders' },
  { key: 'order.reject',         label: 'Reject Order',            module: 'Orders' },
  // Invoice / Payment / Dispatch / Production
  { key: 'invoice.view',         label: 'View Invoices',           module: 'Invoice' },
  { key: 'invoice.create',       label: 'Create Invoice',          module: 'Invoice' },
  { key: 'payment.view',         label: 'View Payments',           module: 'Payments' },
  { key: 'payment.create',       label: 'Create Payment',          module: 'Payments' },
  { key: 'dispatch.view',        label: 'View Dispatch',           module: 'Dispatch' },
  { key: 'dispatch.create',      label: 'Create Dispatch',         module: 'Dispatch' },
  { key: 'production.view',      label: 'View Production',         module: 'Production' },
  { key: 'production.update',    label: 'Update Production',       module: 'Production' },
  // Staff / Settings
  { key: 'staff.view',           label: 'View Staff',              module: 'Staff' },
  { key: 'staff.create',         label: 'Create Staff',            module: 'Staff' },
  { key: 'staff.edit',           label: 'Edit Staff',              module: 'Staff' },
  { key: 'staff.deactivate',     label: 'Deactivate Staff',        module: 'Staff' },
  { key: 'rbac.manage',          label: 'Manage Roles & Permissions', module: 'Settings' },
  { key: 'settings.view',        label: 'View Settings',           module: 'Settings' },
  // CRM
  { key: 'lead.view',            label: 'View Leads',              module: 'CRM' },
  { key: 'lead.create',          label: 'Create Lead',             module: 'CRM' },
  { key: 'lead.edit',            label: 'Edit Lead',               module: 'CRM' },
  { key: 'lead.delete',          label: 'Delete Lead',             module: 'CRM' },
  { key: 'lead.assign',          label: 'Assign Lead',             module: 'CRM' },
  { key: 'lead.convert',         label: 'Convert Lead',            module: 'CRM' },
  { key: 'crm.analytics.self',   label: 'View Own CRM Analytics',  module: 'CRM' },
  { key: 'crm.analytics.team',   label: 'View Team CRM Analytics', module: 'CRM' },
  { key: 'crm.analytics.all',    label: 'View All CRM Analytics',  module: 'CRM' },
  { key: 'whatsapp.manage',      label: 'Manage WhatsApp',         module: 'WhatsApp' },
];

// ─── Role definitions: which permissions each role gets ───────────────────────
const ADMIN_ALL = PERMISSIONS.map(p => p.key);

const ROLE_PERMISSIONS = {
  'Admin': ADMIN_ALL,
  'COO': ADMIN_ALL,
  'Sales Manager': [
    'customer.view','customer.create','customer.edit',
    'item.view',
    'quotation.view','quotation.create','quotation.edit','quotation.cancel','quotation.convert',
    'order.view','order.create','order.edit','order.cancel','order.approve','order.reject',
    'invoice.view','invoice.create',
    'payment.view','payment.create',
    'dispatch.view','dispatch.create',
    'production.view',
    'staff.view',
    'lead.view','lead.create','lead.edit','lead.assign','lead.convert',
    'crm.analytics.self','crm.analytics.team','crm.analytics.all',
  ],
  'Sales Executive': [
    'customer.view','customer.create','customer.edit',
    'item.view',
    'quotation.view','quotation.create','quotation.edit','quotation.cancel','quotation.convert',
    'order.view','order.create','order.edit','order.cancel',
    'invoice.view',
    'payment.view',
    'dispatch.view',
    'production.view',
    'lead.view','lead.create','lead.edit','lead.convert',
    'crm.analytics.self',
  ],
  'Tele calling Executive': [
    'customer.view',
    'item.view',
    'quotation.view','quotation.create',
    'lead.view','lead.create','lead.edit',
    'crm.analytics.self',
  ],
  'Territory Manager': [
    'customer.view','customer.create','customer.edit',
    'item.view',
    'quotation.view','quotation.create','quotation.edit',
    'order.view','order.create',
    'lead.view','lead.create','lead.edit','lead.convert',
    'crm.analytics.self',
  ],
  'Field Executive': [
    'customer.view','customer.create',
    'item.view',
    'quotation.view','quotation.create',
    'lead.view','lead.create','lead.edit',
    'crm.analytics.self',
  ],
};

async function main() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('Connected to prod DB.\n');

  try {
    // ── 1. RBAC tables ───────────────────────────────────────────────────────
    console.log('1/6  Creating RBAC tables...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS permission (
        id     SERIAL PRIMARY KEY,
        key    VARCHAR(100) UNIQUE NOT NULL,
        label  VARCHAR(255) NOT NULL,
        module VARCHAR(100) NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS role (
        id        SERIAL PRIMARY KEY,
        name      VARCHAR(100) UNIQUE NOT NULL,
        is_system BOOLEAN NOT NULL DEFAULT true,
        is_active BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permission (
        role_id       INT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
        permission_id INT NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )
    `);
    console.log('     ✓ permission, role, role_permission');

    // ── 2. Seed permissions ──────────────────────────────────────────────────
    console.log('2/6  Seeding permissions...');
    for (const p of PERMISSIONS) {
      await client.query(`
        INSERT INTO permission (key, label, module)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module
      `, [p.key, p.label, p.module]);
    }
    console.log(`     ✓ ${PERMISSIONS.length} permissions`);

    // ── 3. Seed roles & assign permissions ──────────────────────────────────
    console.log('3/6  Seeding roles and permissions...');
    for (const [roleName, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
      // Upsert role
      await client.query(`
        INSERT INTO role (name, is_system, is_active)
        VALUES ($1, true, true)
        ON CONFLICT (name) DO NOTHING
      `, [roleName]);

      const roleRow = await client.query(`SELECT id FROM role WHERE name = $1`, [roleName]);
      const roleId = roleRow.rows[0].id;

      // Assign permissions
      for (const key of permKeys) {
        await client.query(`
          INSERT INTO role_permission (role_id, permission_id)
          SELECT $1, id FROM permission WHERE key = $2
          ON CONFLICT DO NOTHING
        `, [roleId, key]);
      }
      console.log(`     ✓ ${roleName} (${permKeys.length} permissions)`);
    }

    // ── 4. CRM tables ────────────────────────────────────────────────────────
    console.log('4/6  Creating CRM tables...');
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
        customer_id      INT,
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
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_id ON leads(external_id) WHERE external_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_phone       ON leads(phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON leads(assigned_to)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_status      ON leads(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_created_at  ON leads(created_at)`);

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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_followups_due ON lead_followups(due_date) WHERE is_completed = false`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_settings (
        id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL, value TEXT, updated_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id SERIAL PRIMARY KEY, session_name VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'DISCONNECTED',
        qr_code TEXT, phone_number VARCHAR(20), connected_at TIMESTAMPTZ, last_active_at TIMESTAMPTZ
      )
    `);
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON whatsapp_messages(chat_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_lead ON whatsapp_messages(lead_id)`);

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
    console.log('     ✓ leads, lead_notes, lead_followups, crm_settings, whatsapp_*, notifications');

    // ── 5. Ensure user table columns ─────────────────────────────────────────
    console.log('5/6  Ensuring user table columns...');
    await client.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE`);
    await client.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`);
    await client.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS marketing_area VARCHAR(255)`);
    console.log('     ✓ user columns');

    // ── 6. Create / update Admin user ────────────────────────────────────────
    console.log('6/6  Creating Admin user...');
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const find = await client.query(
      `SELECT id FROM "user" WHERE RIGHT(REGEXP_REPLACE(COALESCE(mobile,''),'[^0-9]','','g'),10) = $1 LIMIT 1`,
      [ADMIN_MOBILE],
    );
    if (find.rows.length) {
      await client.query(
        `UPDATE "user" SET name=$1, role='Admin', is_active=true, can_approve_order=true, password_hash=$2 WHERE id=$3`,
        [ADMIN_NAME, hash, find.rows[0].id],
      );
      console.log(`     ✓ Updated existing user id=${find.rows[0].id}`);
    } else {
      await client.query(
        `INSERT INTO "user" (name, mobile, role, is_active, can_approve_order, commission_rate, password_hash)
         VALUES ($1, $2, 'Admin', true, true, 0, $3)`,
        [ADMIN_NAME, ADMIN_MOBILE, hash],
      );
      console.log('     ✓ Inserted new Admin user');
    }

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Migration complete!

Admin credentials:
  Mobile:   ${ADMIN_MOBILE}
  Password: ${ADMIN_PASSWORD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });

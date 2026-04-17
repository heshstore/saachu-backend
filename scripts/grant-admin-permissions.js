/* eslint-disable no-console */
/**
 * Gives the Admin (and COO) role every permission in the permission table.
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 *
 * Usage (prod DB):
 *   DATABASE_URL=<prod-url> node scripts/grant-admin-permissions.js
 *
 * Usage (local DB — reads .env automatically):
 *   node scripts/grant-admin-permissions.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const ALL_PERMISSIONS = [
  // Customers
  { key: 'customer.view',        label: 'View Customers',             module: 'Customers' },
  { key: 'customer.create',      label: 'Create Customer',            module: 'Customers' },
  { key: 'customer.edit',        label: 'Edit Customer',              module: 'Customers' },
  { key: 'customer.delete',      label: 'Delete Customer',            module: 'Customers' },
  // Items
  { key: 'item.view',            label: 'View Items',                 module: 'Items' },
  { key: 'item.create',          label: 'Create Item',                module: 'Items' },
  { key: 'item.edit',            label: 'Edit Item',                  module: 'Items' },
  { key: 'item.shopify_sync',    label: 'Shopify Sync',               module: 'Items' },
  // Quotations
  { key: 'quotation.view',       label: 'View Quotations',            module: 'Quotations' },
  { key: 'quotation.create',     label: 'Create Quotation',           module: 'Quotations' },
  { key: 'quotation.edit',       label: 'Edit Quotation',             module: 'Quotations' },
  { key: 'quotation.cancel',     label: 'Cancel Quotation',           module: 'Quotations' },
  { key: 'quotation.convert',    label: 'Convert to Order',           module: 'Quotations' },
  // Orders
  { key: 'order.view',           label: 'View Orders',                module: 'Orders' },
  { key: 'order.create',         label: 'Create Order',               module: 'Orders' },
  { key: 'order.edit',           label: 'Edit Order',                 module: 'Orders' },
  { key: 'order.cancel',         label: 'Cancel Order',               module: 'Orders' },
  { key: 'order.approve',        label: 'Approve Order',              module: 'Orders' },
  { key: 'order.reject',         label: 'Reject Order',               module: 'Orders' },
  // Invoice / Payment / Dispatch / Production
  { key: 'invoice.view',         label: 'View Invoices',              module: 'Invoice' },
  { key: 'invoice.create',       label: 'Create Invoice',             module: 'Invoice' },
  { key: 'payment.view',         label: 'View Payments',              module: 'Payments' },
  { key: 'payment.create',       label: 'Create Payment',             module: 'Payments' },
  { key: 'dispatch.view',        label: 'View Dispatch',              module: 'Dispatch' },
  { key: 'dispatch.create',      label: 'Create Dispatch',            module: 'Dispatch' },
  { key: 'production.view',      label: 'View Production',            module: 'Production' },
  { key: 'production.update',    label: 'Update Production',          module: 'Production' },
  // Staff / Settings
  { key: 'staff.view',           label: 'View Staff',                 module: 'Staff' },
  { key: 'staff.create',         label: 'Create Staff',               module: 'Staff' },
  { key: 'staff.edit',           label: 'Edit Staff',                 module: 'Staff' },
  { key: 'staff.deactivate',     label: 'Deactivate Staff',           module: 'Staff' },
  { key: 'rbac.manage',          label: 'Manage Roles & Permissions', module: 'Settings' },
  { key: 'settings.view',        label: 'View Settings',              module: 'Settings' },
  // CRM
  { key: 'lead.view',            label: 'View Leads',                 module: 'CRM' },
  { key: 'lead.create',          label: 'Create Lead',                module: 'CRM' },
  { key: 'lead.edit',            label: 'Edit Lead',                  module: 'CRM' },
  { key: 'lead.delete',          label: 'Delete Lead',                module: 'CRM' },
  { key: 'lead.assign',          label: 'Assign Lead',                module: 'CRM' },
  { key: 'lead.convert',         label: 'Convert Lead',               module: 'CRM' },
  { key: 'crm.analytics.self',   label: 'View Own CRM Analytics',     module: 'CRM' },
  { key: 'crm.analytics.team',   label: 'View Team CRM Analytics',    module: 'CRM' },
  { key: 'crm.analytics.all',    label: 'View All CRM Analytics',     module: 'CRM' },
  { key: 'whatsapp.manage',      label: 'Manage WhatsApp',            module: 'WhatsApp' },
];

const FULL_ACCESS_ROLES = ['Admin', 'COO'];

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    // 1. Ensure permission table has all permissions
    console.log('Upserting permissions...');
    for (const p of ALL_PERMISSIONS) {
      await client.query(
        `INSERT INTO permission (key, label, module)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module`,
        [p.key, p.label, p.module],
      );
    }
    console.log(`  ✓ ${ALL_PERMISSIONS.length} permissions upserted`);

    // 2. Ensure Admin and COO roles exist
    for (const roleName of FULL_ACCESS_ROLES) {
      await client.query(
        `INSERT INTO role (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [roleName],
      );
    }

    // 3. Give Admin + COO every permission
    for (const roleName of FULL_ACCESS_ROLES) {
      const res = await client.query(`
        INSERT INTO role_permission (role_id, permission_id)
        SELECT r.id, p.id
        FROM role r CROSS JOIN permission p
        WHERE r.name = $1
        ON CONFLICT DO NOTHING
      `, [roleName]);
      console.log(`  ✓ ${roleName}: granted all permissions (${res.rowCount ?? 0} new rows)`);
    }

    // 4. Fix any Admin users whose role string is not exactly 'Admin'
    const legacyFix = await client.query(
      `UPDATE "user" SET role = 'Admin'
       WHERE LOWER(TRIM(COALESCE(role, ''))) IN ('admin', 'master admin', 'masteradmin', 'super admin', 'superadmin')
         AND role != 'Admin'`,
    );
    if (legacyFix.rowCount > 0) {
      console.log(`  ✓ Normalized ${legacyFix.rowCount} legacy admin role string(s) to 'Admin'`);
    }

    console.log('\nDone. Admin and COO roles now have all permissions.');
    console.log('Note: The PermissionGuard also hard-codes Admin bypass — so this is belt-and-suspenders.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

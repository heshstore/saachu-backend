/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

const CRM_PERMISSIONS = [
  { key: 'lead.view',          label: 'View Leads',              module: 'CRM' },
  { key: 'lead.create',        label: 'Create Lead',             module: 'CRM' },
  { key: 'lead.edit',          label: 'Edit Lead',               module: 'CRM' },
  { key: 'lead.delete',        label: 'Delete Lead',             module: 'CRM' },
  { key: 'lead.assign',        label: 'Assign Lead',             module: 'CRM' },
  { key: 'lead.convert',       label: 'Convert Lead',            module: 'CRM' },
  { key: 'crm.analytics.self', label: 'View Own CRM Analytics',  module: 'CRM' },
  { key: 'crm.analytics.team', label: 'View Team CRM Analytics', module: 'CRM' },
  { key: 'crm.analytics.all',  label: 'View All CRM Analytics',  module: 'CRM' },
  { key: 'whatsapp.manage',    label: 'Manage WhatsApp',         module: 'WhatsApp' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    console.log('Seeding CRM permissions...');

    for (const p of CRM_PERMISSIONS) {
      await client.query(
        `INSERT INTO permission (key, label, module)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING`,
        [p.key, p.label, p.module],
      );
      console.log(`  ✓ ${p.key}`);
    }

    // Give Admin role all CRM permissions
    await client.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r CROSS JOIN permission p
      WHERE r.name = 'Admin'
        AND p.key IN (${CRM_PERMISSIONS.map((_, i) => `$${i + 1}`).join(',')})
      ON CONFLICT DO NOTHING
    `, CRM_PERMISSIONS.map(p => p.key));

    // Give Sales Manager + COO team-level analytics and lead management
    const salesRoles = ['Sales Manager', 'COO'];
    const salesPerms = ['lead.view', 'lead.create', 'lead.edit', 'lead.assign', 'lead.convert',
                        'crm.analytics.self', 'crm.analytics.team'];
    for (const roleName of salesRoles) {
      await client.query(`
        INSERT INTO role_permission (role_id, permission_id)
        SELECT r.id, p.id
        FROM role r CROSS JOIN permission p
        WHERE r.name = $1
          AND p.key IN (${salesPerms.map((_, i) => `$${i + 2}`).join(',')})
        ON CONFLICT DO NOTHING
      `, [roleName, ...salesPerms]);
    }

    // Give Tele calling Executive, Territory Manager, Field Executive basic lead perms
    const telecallerRoles = ['Tele calling Executive', 'Territory Manager', 'Field Executive'];
    const telecallerPerms = ['lead.view', 'lead.create', 'lead.edit', 'crm.analytics.self'];
    for (const roleName of telecallerRoles) {
      await client.query(`
        INSERT INTO role_permission (role_id, permission_id)
        SELECT r.id, p.id
        FROM role r CROSS JOIN permission p
        WHERE r.name = $1
          AND p.key IN (${telecallerPerms.map((_, i) => `$${i + 2}`).join(',')})
        ON CONFLICT DO NOTHING
      `, [roleName, ...telecallerPerms]);
    }

    console.log('\nCRM permissions seeded successfully.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

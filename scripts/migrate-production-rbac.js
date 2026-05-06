require('dotenv').config();
const { Client } = require('pg');

const NEW_PERMISSIONS = [
  { key: 'production.assign',          label: 'Assign Production Jobs',        module: 'Production' },
  { key: 'production.update_stage',    label: 'Update Production Stage',       module: 'Production' },
  { key: 'production.update_priority', label: 'Update Production Priority',    module: 'Production' },
  { key: 'production.analytics',       label: 'View Production Analytics',     module: 'Production' },
  { key: 'production.decision_engine', label: 'Run Production Decision Engine',module: 'Production' },
];

// Role name → permission keys to grant (in addition to what they already have)
const ROLE_PERMISSIONS = {
  'Production Manager': [
    'production.view',
    'production.assign',
    'production.update_stage',
    'production.update_priority',
    'production.analytics',
  ],
  'Production Staff': [
    'production.view',
    'production.update_stage',
  ],
};

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 1. Upsert new permissions
    for (const p of NEW_PERMISSIONS) {
      await client.query(
        `INSERT INTO permission (key, label, module)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, module = EXCLUDED.module`,
        [p.key, p.label, p.module],
      );
    }
    console.log(`${NEW_PERMISSIONS.length} permissions upserted`);

    // 2. Upsert roles and grant permissions
    for (const [roleName, keys] of Object.entries(ROLE_PERMISSIONS)) {
      // Ensure role exists
      await client.query(
        `INSERT INTO role (name, is_active, is_system)
         VALUES ($1, true, false)
         ON CONFLICT (name) DO NOTHING`,
        [roleName],
      );

      const roleRes = await client.query(`SELECT id FROM role WHERE name = $1`, [roleName]);
      const roleId  = roleRes.rows[0]?.id;
      if (!roleId) { console.warn(`Role not found: ${roleName}`); continue; }

      for (const key of keys) {
        const permRes = await client.query(`SELECT id FROM permission WHERE key = $1`, [key]);
        const permId  = permRes.rows[0]?.id;
        if (!permId) { console.warn(`Permission not found: ${key}`); continue; }

        await client.query(
          `INSERT INTO role_permission (role_id, permission_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [roleId, permId],
        );
      }
      console.log(`${roleName}: ${keys.length} permissions granted`);
    }
  } finally {
    await client.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });

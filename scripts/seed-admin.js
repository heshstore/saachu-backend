/**
 * Creates or resets the bootstrap Admin user (mobile login, role = Admin).
 *
 * Run from backend folder:
 *   npm run seed:admin
 *
 * Uses DATABASE_URL from .env (supports Neon: ssl auto-enabled).
 *
 * After first login, change the password from Staff Management or
 * PATCH /auth/change-password.
 */
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcrypt');

const ADMIN_MOBILE = process.env.ADMIN_MOBILE || process.env.MASTER_MOBILE || '9000000001';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.MASTER_PASSWORD || 'Saachu!Recover2026';
const ADMIN_NAME = process.env.ADMIN_NAME || process.env.MASTER_NAME || 'Admin';
const LEGACY_ADMIN_ROLES = ['master admin', 'masteradmin', 'super admin', 'superadmin'];

function normalizeMobile(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function ensureUserColumns(client) {
  await client.query(`
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS email VARCHAR(255);
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE "user" ADD COLUMN IF NOT EXISTS marketing_area VARCHAR(255);
  `);
}

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return r.rows.length > 0;
}

async function normalizeLegacyAdminRoles(client) {
  await client.query(
    `
      UPDATE "user"
      SET role = 'Admin'
      WHERE LOWER(TRIM(COALESCE(role, ''))) = ANY($1::text[])
    `,
    [LEGACY_ADMIN_ROLES],
  );

  const hasRole = await tableExists(client, 'role');
  const hasRp = await tableExists(client, 'role_permission');
  if (!hasRole) return;

  const adminRole = await client.query(`SELECT id FROM role WHERE name = 'Admin' LIMIT 1`);
  const legacyRoles = await client.query(
    `
      SELECT id, name
      FROM role
      WHERE LOWER(TRIM(name)) = ANY($1::text[])
    `,
    [LEGACY_ADMIN_ROLES],
  );

  if (!legacyRoles.rows.length) return;

  let adminRoleId = adminRole.rows[0]?.id ?? null;
  if (!adminRoleId) {
    await client.query(`UPDATE role SET name = 'Admin' WHERE id = $1`, [legacyRoles.rows[0].id]);
    adminRoleId = legacyRoles.rows[0].id;
  }

  if (hasRp) {
    for (const row of legacyRoles.rows) {
      if (row.id === adminRoleId) continue;
      await client.query(
        `
          INSERT INTO role_permission (role_id, permission_id)
          SELECT $1, permission_id
          FROM role_permission
          WHERE role_id = $2
          ON CONFLICT DO NOTHING
        `,
        [adminRoleId, row.id],
      );
    }
  }

  for (const row of legacyRoles.rows) {
    if (row.id === adminRoleId) continue;
    await client.query(`DELETE FROM role WHERE id = $1`, [row.id]);
  }
}

/** Give Admin role all permissions if RBAC tables exist (avoids empty permissions after login). */
async function ensureAdminRbac(client) {
  const hasRole = await tableExists(client, 'role');
  const hasPerm = await tableExists(client, 'permission');
  const hasRp = await tableExists(client, 'role_permission');
  if (!hasRole || !hasPerm || !hasRp) {
    console.log('RBAC tables not found — run your RBAC migration if the app returns 403 after login.');
    return;
  }
  await client.query(`
    INSERT INTO role_permission (role_id, permission_id)
    SELECT r.id, p.id FROM role r CROSS JOIN permission p
    WHERE r.name = 'Admin'
    ON CONFLICT DO NOTHING
  `);
  console.log('Linked Admin role to all permissions (where RBAC tables exist).');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is missing in .env');
    process.exit(1);
  }

  const adminMobile = normalizeMobile(ADMIN_MOBILE);
  if (!adminMobile) {
    console.error('ADMIN_MOBILE is invalid');
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const client = new Client({
    connectionString: url,
    ssl: sslOption(url),
  });

  await client.connect();
  try {
    await ensureUserColumns(client);
    await normalizeLegacyAdminRoles(client);

    const find = await client.query(
      `SELECT id FROM "user"
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(mobile, ''), '[^0-9]', '', 'g'), 10) = $1
       LIMIT 1`,
      [adminMobile],
    );

    if (find.rows.length) {
      await client.query(
        `UPDATE "user" SET
           name = $1,
           mobile = $2,
           role = 'Admin',
           "is_active" = true,
           "can_approve_order" = true,
           password_hash = $3
         WHERE id = $4`,
        [ADMIN_NAME, adminMobile, password_hash, find.rows[0].id],
      );
      console.log(`Updated existing user id=${find.rows[0].id} (role Admin).`);
    } else {
      await client.query(
        `INSERT INTO "user" (name, mobile, email, role, "is_active", "can_approve_order", "commission_rate", password_hash)
         VALUES ($1, $2, NULL, 'Admin', true, true, 2, $3)`,
        [ADMIN_NAME, adminMobile, password_hash],
      );
      console.log('Inserted new Admin user.');
    }

    await ensureAdminRbac(client);
  } finally {
    await client.end();
  }

  console.log('');
  console.log('=== Admin login (Sign In screen) ===');
  console.log(`  Mobile:   ${adminMobile}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log('');
  console.log('Change this password after you log in.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

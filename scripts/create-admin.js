const bcrypt = require('bcrypt');
const { Client } = require('pg');

async function run() {
  const hash = await bcrypt.hash('Saachu@2026', 10);

  const client = new Client({
    connectionString: 'postgresql://neondb_owner:npg_hlAOPvN2r6po@ep-noisy-pond-a1nmenkk-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const res = await client.query(`
    INSERT INTO "user" (name, mobile, email, password_hash, role, is_active, can_approve_order, commission_rate)
    VALUES ('Admin', '9000000001', 'admin@saachu.com', $1, 'Admin', true, true, 0)
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role          = 'Admin',
      is_active     = true,
      can_approve_order = true
    RETURNING id, name, mobile, email, role
  `, [hash]);

  console.log('✅ Admin created:', res.rows[0]);
  await client.end();
}

run().catch((e) => { console.error('❌', e.message); process.exit(1); });

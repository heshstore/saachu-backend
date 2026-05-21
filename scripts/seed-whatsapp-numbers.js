/**
 * seed-whatsapp-numbers.js
 *
 * Seeds the initial telecaller WhatsApp numbers into whatsapp_numbers.
 * Idempotent — uses INSERT ... ON CONFLICT (phone) DO NOTHING.
 *
 * Run: node scripts/seed-whatsapp-numbers.js
 */

const { Client } = require('pg');
require('dotenv').config();

const NUMBERS = [
  { name: 'Telecaller 1', phone: '9176052555' },
  { name: 'Telecaller 2', phone: '9381852555' },
  { name: 'Telecaller 3', phone: '9382152555' },
];

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped  = 0;

    for (const num of NUMBERS) {
      const { rowCount } = await client.query(
        `INSERT INTO whatsapp_numbers
           (name, phone, status, warmup_level, daily_limit, daily_sent, risk_score, is_active)
         VALUES ($1, $2, 'active', 1, 10, 0, 0, true)
         ON CONFLICT (phone) DO NOTHING`,
        [num.name, num.phone],
      );

      if (rowCount > 0) {
        console.log(`  + inserted: ${num.name} (${num.phone})`);
        inserted++;
      } else {
        console.log(`  ~ skipped:  ${num.name} (${num.phone}) — already exists`);
        skipped++;
      }
    }

    await client.query('COMMIT');

    console.log(`\n✅ Done — inserted: ${inserted}, skipped: ${skipped}`);

    // Verify final state
    const { rows } = await client.query(
      `SELECT name, phone, status, warmup_level, daily_limit, is_active
       FROM whatsapp_numbers ORDER BY created_at`,
    );
    console.log('\nCurrent whatsapp_numbers:');
    rows.forEach((r) =>
      console.log(`  ${r.name.padEnd(14)} ${r.phone.padEnd(12)} status=${r.status} warmup=${r.warmup_level} limit=${r.daily_limit}/day active=${r.is_active}`),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

/* eslint-disable no-console */
/**
 * migrate-platform.js
 *
 * Normalizes the `source` column in `leads` to the canonical platform list:
 *   SHOPIFY | META | GOOGLE | INDIAMART | LINKEDIN | WHATSAPP | DIRECT | MANUAL
 *
 * Also renames round-robin keys in `crm_settings` to stay consistent.
 * Safe to re-run — all statements are idempotent.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|sslmode=require|ssl=true/i.test(url)) return { rejectUnauthorized: false };
  return undefined;
}

const RENAMES = [
  // [from,          to       ]
  ['META_ADS',    'META'    ],
  ['FACEBOOK',    'META'    ],
  ['FB',          'META'    ],
  ['INSTAGRAM',   'META'    ],
  ['GOOGLE_ADS',  'GOOGLE'  ],
  ['DIRECT_CALL', 'DIRECT'  ],
  ['MANUAL',      'DIRECT'  ],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();

  try {
    console.log('Normalizing platform values...\n');

    // ── leads.source ─────────────────────────────────────────────────────────
    for (const [from, to] of RENAMES) {
      const { rowCount } = await client.query(
        `UPDATE leads SET source = $1 WHERE source = $2`,
        [to, from],
      );
      if (rowCount > 0) console.log(`  leads: ${from} → ${to} (${rowCount} rows)`);
    }

    // Anything still unknown → DIRECT
    const { rowCount: unknownCount } = await client.query(`
      UPDATE leads
         SET source = 'DIRECT'
       WHERE source NOT IN ('SHOPIFY','META','GOOGLE','INDIAMART','LINKEDIN','WHATSAPP','DIRECT','MANUAL')
    `);
    if (unknownCount > 0) console.log(`  leads: ${unknownCount} unknown values → DIRECT`);

    console.log('  ✓ leads.source normalized');

    // ── crm_settings round-robin keys ────────────────────────────────────────
    const rrRenames = [
      ['round_robin_META_ADS',    'round_robin_META'   ],
      ['round_robin_GOOGLE_ADS',  'round_robin_GOOGLE' ],
      ['round_robin_DIRECT_CALL', 'round_robin_DIRECT' ],
      ['round_robin_MANUAL',      'round_robin_DIRECT' ],
    ];

    for (const [from, to] of rrRenames) {
      // Only rename if new key doesn't already exist
      const exists = await client.query(
        `SELECT 1 FROM crm_settings WHERE key = $1`, [to],
      );
      if (exists.rowCount > 0) {
        // New key already exists — just delete the old one to avoid duplicate
        await client.query(`DELETE FROM crm_settings WHERE key = $1`, [from]);
        console.log(`  crm_settings: ${from} deleted (${to} already exists)`);
      } else {
        const { rowCount } = await client.query(
          `UPDATE crm_settings SET key = $1 WHERE key = $2`, [to, from],
        );
        if (rowCount > 0) console.log(`  crm_settings: ${from} → ${to}`);
      }
    }

    console.log('  ✓ crm_settings keys normalized');
    console.log('\nPlatform migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

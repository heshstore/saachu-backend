/**
 * migrate-whatsapp-inbox-phase1.js
 *
 * Inbox Phase 1 schema additions:
 *   - whatsapp_replies.conversation_key  (normalized_sender_phone|number_id)
 *
 * Idempotent — safe to run multiple times on any database state.
 * Run: node scripts/migrate-whatsapp-inbox-phase1.js
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
      return false;
    }
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    added.push(`${table}.${column}`);
    console.log(`  + added: ${table}.${column}`);
    return true;
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

    // ── whatsapp_replies ────────────────────────────────────────────────────────
    console.log('[ whatsapp_replies ]');
    await addColumnIfMissing('whatsapp_replies', 'conversation_key', 'VARCHAR NULL');
    await createIndexIfMissing(
      'idx_wr_conversation_key',
      'whatsapp_replies',
      '(conversation_key)',
    );

    // Backfill existing rows: set conversation_key from customer_phone + number_id
    const { rowCount } = await client.query(`
      UPDATE whatsapp_replies
      SET conversation_key = customer_phone || '|' || COALESCE(number_id::text, '')
      WHERE conversation_key IS NULL
    `);
    if (rowCount > 0) {
      console.log(`  ~ backfilled conversation_key for ${rowCount} existing row(s)`);
    }

    await client.query('COMMIT');

    console.log('\n─────────────────────────────────────');
    console.log(`Added   : ${added.length > 0 ? added.join(', ') : 'nothing new'}`);
    console.log(`Skipped : ${skipped.length > 0 ? skipped.join(', ') : 'none'}`);
    console.log('Migration complete.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nMigration FAILED — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

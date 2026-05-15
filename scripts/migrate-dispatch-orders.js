/**
 * Dispatch orders (multi-line, ledger-backed) + dispatch_order_items.
 * Run: node scripts/migrate-dispatch-orders.js
 */
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is missing');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  try {
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS dispatch_order_number_seq START 1;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatch_orders (
        id SERIAL PRIMARY KEY,
        dispatch_number VARCHAR(40) NOT NULL UNIQUE,
        order_id INT NOT NULL REFERENCES orders(id),
        customer_id INT NULL,
        dispatch_date TIMESTAMPTZ NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
        remarks TEXT,
        created_by INT NULL,
        transporter_name VARCHAR(255) NULL,
        lr_number VARCHAR(120) NULL,
        tracking_number VARCHAR(120) NULL,
        in_transit_at TIMESTAMPTZ NULL,
        delivered_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_orders_order ON dispatch_orders (order_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_orders_status ON dispatch_orders (status);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatch_order_items (
        id SERIAL PRIMARY KEY,
        dispatch_order_id INT NOT NULL REFERENCES dispatch_orders(id) ON DELETE CASCADE,
        order_item_id INT NOT NULL REFERENCES order_item(id),
        item_id INT NOT NULL,
        ordered_qty DOUBLE PRECISION NOT NULL,
        dispatched_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        pending_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        packed_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        delivered_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        packing_remarks TEXT,
        carton_count INT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_dispatch_line UNIQUE (dispatch_order_id, order_item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_order_items_dispatch ON dispatch_order_items (dispatch_order_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_order_items_order_item ON dispatch_order_items (order_item_id);
    `);
    await client.query(`
      ALTER TABLE orders ALTER COLUMN status TYPE VARCHAR(30);
    `);
    console.log('✓ dispatch_orders + dispatch_order_items ensured');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

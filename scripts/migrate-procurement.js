/**
 * Procurement foundation: vendors, vendor_item_mappings, purchase_orders,
 * purchase_order_items, PR link columns, PO number sequence.
 *
 * Run: node scripts/migrate-procurement.js
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
      CREATE TABLE IF NOT EXISTS vendors (
        id SERIAL PRIMARY KEY,
        vendor_code VARCHAR(40) NOT NULL UNIQUE,
        vendor_name VARCHAR(255) NOT NULL,
        contact_person VARCHAR(200),
        phone VARCHAR(40),
        email VARCHAR(200),
        gst_number VARCHAR(32),
        address TEXT,
        city VARCHAR(120),
        state VARCHAR(120),
        pincode VARCHAR(20),
        payment_terms VARCHAR(255),
        active BOOLEAN NOT NULL DEFAULT true,
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS vendor_item_mappings (
        id SERIAL PRIMARY KEY,
        vendor_id INT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
        item_id INT NOT NULL,
        item_source VARCHAR(20) NOT NULL DEFAULT 'SERVICE',
        vendor_sku VARCHAR(120),
        purchase_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
        minimum_order_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        lead_time_days INT NOT NULL DEFAULT 0,
        preferred_vendor BOOLEAN NOT NULL DEFAULT false,
        last_purchase_rate DOUBLE PRECISION,
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_vendor_item UNIQUE (vendor_id, item_id, item_source)
      );

      CREATE INDEX IF NOT EXISTS idx_vendor_item_item ON vendor_item_mappings (item_id, item_source);

      CREATE SEQUENCE IF NOT EXISTS po_number_seq START 1;

      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY,
        po_number VARCHAR(40) NOT NULL UNIQUE,
        vendor_id INT NOT NULL REFERENCES vendors(id),
        warehouse_id INT REFERENCES warehouses(id),
        order_date DATE NOT NULL DEFAULT CURRENT_DATE,
        expected_date DATE,
        status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
        subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
        gst_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        notes TEXT,
        created_by INT REFERENCES "user"(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        item_id INT NOT NULL,
        item_source VARCHAR(20) NOT NULL DEFAULT 'SERVICE',
        qty DOUBLE PRECISION NOT NULL,
        rate DOUBLE PRECISION NOT NULL,
        gst_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
        line_total DOUBLE PRECISION NOT NULL,
        received_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
        linked_pr_ids JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items (purchase_order_id);
    `);

    await client.query(`
      ALTER TABLE purchase_requirements
        ADD COLUMN IF NOT EXISTS purchase_order_id INT REFERENCES purchase_orders(id);
      ALTER TABLE purchase_requirements
        ADD COLUMN IF NOT EXISTS po_number VARCHAR(40);
    `);

    console.log('✓ Procurement tables and PR columns ensured');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

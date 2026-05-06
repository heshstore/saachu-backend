/* eslint-disable no-console */
/**
 * Migrates the orders and order_item tables to the v2 schema:
 *
 * orders:
 *   - Adds: order_no, lead_id, customer_phone, billing_address, shipping_address,
 *           gst_number, subtotal, discount_type, discount_value,
 *           packing_charges, cartage_charges, forwarding_charges,
 *           installation_charges, loading_charges,
 *           approval_remarks, approved_by_id, created_by, updated_at
 *   - Backfills charges from old charges_* columns
 *   - Backfills order_no from order_number (ORD-00001 → ORD0001 format)
 *   - Backfills customer_phone from customer table
 *   - Migrates 'Draft' status → 'PENDING_APPROVAL'
 *   - Creates order_no_seq sequence
 *   - Creates idx_order_customer and idx_order_status indexes
 *
 * order_item:
 *   - Adds: sku, item_name, hsn_code, qty, base_rate, discount_type,
 *           discount_value, gst_percent, gst_amount, instruction
 *   - Backfills item_name from itemName, qty from quantity
 *
 * Idempotent — safe to re-run.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set in .env');

  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('Connected to database');

  // ── orders table ────────────────────────────────────────────────────────────

  const orderCols = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_no             VARCHAR(20)     NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS lead_id              INT             NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone       VARCHAR(30)     NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_address      TEXT            NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address     TEXT            NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS gst_number           VARCHAR(20)     NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal             NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_type        VARCHAR(10)     NOT NULL DEFAULT 'PERCENT'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_value       NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS packing_charges      NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cartage_charges      NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS forwarding_charges   NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS installation_charges NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS loading_charges      NUMERIC(10,2)   NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS approval_remarks     TEXT            NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_by_id       INT             NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by           INT             NULL`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMP       NULL`,
  ];

  for (const sql of orderCols) {
    await client.query(sql);
  }
  console.log('✓ orders columns ensured');

  // order_no unique index — only if column doesn't already have one
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_order_no ON orders(order_no) WHERE order_no IS NOT NULL
  `);

  // Backfill subtotal from taxable_amount (existing column) or total_amount as fallback
  await client.query(`
    UPDATE orders SET subtotal = COALESCE(NULLIF(taxable_amount, 0), total_amount, 0)
    WHERE subtotal = 0 AND (taxable_amount > 0 OR total_amount > 0)
  `);
  console.log('✓ orders subtotal backfilled');

  // Backfill order_no from order_number — strip "ORD-" prefix and leading zeros, re-pad to 4 digits
  await client.query(`
    UPDATE orders
    SET order_no = 'ORD' || LPAD(
      LTRIM(REPLACE(COALESCE(order_number, ''), 'ORD-', ''), '0'),
      4, '0'
    )
    WHERE order_no IS NULL AND order_number IS NOT NULL AND order_number != ''
  `);
  console.log('✓ order_no backfilled from order_number');

  // Backfill customer_phone from customer table
  await client.query(`
    UPDATE orders o
    SET customer_phone = c."mobile1"
    FROM customer c
    WHERE o.customer_id = c.id AND (o.customer_phone IS NULL OR o.customer_phone = '')
  `);
  console.log('✓ customer_phone backfilled from customer table');

  // Migrate legacy status values
  await client.query(`UPDATE orders SET status = 'PENDING_APPROVAL' WHERE status IN ('Draft', 'DRAFT', 'draft')`);
  console.log('✓ Legacy Draft status migrated to PENDING_APPROVAL');

  // Indexes
  await client.query(`CREATE INDEX IF NOT EXISTS idx_order_customer ON orders(customer_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_order_status   ON orders(status)`);
  console.log('✓ orders indexes ensured');

  // ── order_no_seq sequence ───────────────────────────────────────────────────
  await client.query(`
    CREATE SEQUENCE IF NOT EXISTS order_no_seq START WITH 1 INCREMENT BY 1 NO CYCLE
  `);

  const { rows: seedRows } = await client.query(`
    SELECT COALESCE(MAX(
      CASE WHEN order_no ~ '^ORD[0-9]+$'
           THEN LTRIM(substring(order_no FROM 4), '0')::BIGINT
           ELSE NULL END
    ), 0) AS max_no,
    COUNT(*) AS cnt
    FROM orders
    WHERE order_no IS NOT NULL
  `);
  const seed = Math.max(Number(seedRows[0].max_no) || 0, Number(seedRows[0].cnt) || 0);
  if (seed > 0) {
    await client.query(`SELECT setval('order_no_seq', $1, true)`, [seed]);
    console.log(`✓ order_no_seq seeded to ${seed} (next: ORD${String(seed + 1).padStart(4, '0')})`);
  } else {
    console.log('✓ order_no_seq starts at 1 (no existing orders)');
  }

  // ── order_item table ────────────────────────────────────────────────────────
  const itemCols = [
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS sku            VARCHAR(100)  NULL`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS item_name      VARCHAR(500)  NULL`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS hsn_code       VARCHAR(20)   NULL`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS qty            NUMERIC(10,2) NOT NULL DEFAULT 1`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS base_rate      NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(10)   NULL DEFAULT 'percent'`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS gst_percent    NUMERIC(5,2)  NOT NULL DEFAULT 0`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE order_item ADD COLUMN IF NOT EXISTS instruction    TEXT          NULL`,
  ];

  for (const sql of itemCols) {
    await client.query(sql);
  }
  console.log('✓ order_item columns ensured');

  // Backfill item_name from camelCase column, qty from quantity
  await client.query(`
    UPDATE order_item SET
      item_name = COALESCE(item_name, "itemName"),
      qty       = COALESCE(NULLIF(qty, 1), quantity, 1),
      base_rate = COALESCE(NULLIF(base_rate, 0), msp_price, rate, 0)
    WHERE item_name IS NULL OR qty = 1
  `);
  console.log('✓ order_item backfilled');

  await client.end();
  console.log('\nMigration complete.');
}

run().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});

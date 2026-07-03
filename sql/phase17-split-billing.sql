-- Phase 17: Split Billing Schema Extension
-- Additive only. No DROP, no renames, no data loss.
-- Run once against Neon. Wrapped in transaction for all-or-nothing safety.

BEGIN;

-- 1. Classification snapshot on quotation_item
ALTER TABLE quotation_item
  ADD COLUMN IF NOT EXISTS billing_category VARCHAR(20) DEFAULT NULL;

-- 2. Permanent source of truth on order_item
ALTER TABLE order_item
  ADD COLUMN IF NOT EXISTS billing_category VARCHAR(20) DEFAULT NULL;

-- 3. Fix six columns missing from invoice table (entity already declares them correctly)
ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS invoice_no  VARCHAR(50)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS type        VARCHAR(20)   NOT NULL DEFAULT 'TALLY',
  ADD COLUMN IF NOT EXISTS cgst        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW();

-- 4. Split billing company on invoice (NULL = legacy single invoice)
ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS billing_company VARCHAR(20) DEFAULT NULL;

-- 5. Sequences for split invoice numbering (distinct prefixes from legacy INV-)
CREATE SEQUENCE IF NOT EXISTS production_invoice_no_seq START 1;
CREATE SEQUENCE IF NOT EXISTS trading_invoice_no_seq   START 1;

-- 6. One legacy invoice (billing_company IS NULL) per order
CREATE UNIQUE INDEX IF NOT EXISTS invoice_legacy_unique
  ON invoice(order_id)
  WHERE billing_company IS NULL;

-- 7. One PRODUCTION + one TRADING invoice per order
CREATE UNIQUE INDEX IF NOT EXISTS invoice_split_unique
  ON invoice(order_id, billing_company)
  WHERE billing_company IS NOT NULL;

-- 8. Internal split allocation on payment_entries (all nullable — zero impact on existing rows)
ALTER TABLE payment_entries
  ADD COLUMN IF NOT EXISTS production_amount NUMERIC(14,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS production_bank   VARCHAR(100)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trading_amount    NUMERIC(14,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS trading_bank      VARCHAR(100)  DEFAULT NULL;

COMMIT;

-- ============================================================
-- Phase 16 — Shopify Knowledge Fields
-- Adds description, tags, vendor, product_type to
-- shopify_catalog_items for Promotion AI knowledge extraction.
--
-- Safe to run multiple times — all ADD COLUMN use IF NOT EXISTS.
-- Production safe — columns are nullable with NULL default.
-- Existing rows are unaffected; fields populate on next sync.
-- ============================================================

-- ── APPLY ────────────────────────────────────────────────────

ALTER TABLE shopify_catalog_items
  ADD COLUMN IF NOT EXISTS description  TEXT         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tags         VARCHAR      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS vendor       VARCHAR      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS product_type VARCHAR      DEFAULT NULL;

-- Confirm columns exist after migration:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'shopify_catalog_items'
--   AND column_name IN ('description','tags','vendor','product_type')
-- ORDER BY column_name;

-- ── ROLLBACK ─────────────────────────────────────────────────
-- Run ONLY to undo this migration. Drops data permanently.
--
-- ALTER TABLE shopify_catalog_items
--   DROP COLUMN IF EXISTS description,
--   DROP COLUMN IF EXISTS tags,
--   DROP COLUMN IF EXISTS vendor,
--   DROP COLUMN IF EXISTS product_type;

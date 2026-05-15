-- Phase 12 — manufacturing costing & analytics (read-side tables + dispatch cost fields).
-- Run once against the app database (synchronize=false). Idempotent.

CREATE TABLE IF NOT EXISTS department_cost_master (
  id SERIAL PRIMARY KEY,
  department_id INT NOT NULL UNIQUE REFERENCES departments(id) ON DELETE CASCADE,
  cost_per_hour NUMERIC(14,2) NOT NULL DEFAULT 0,
  manpower_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
  overhead_rate NUMERIC(14,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_cost_snapshots (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL,
  production_job_id INT NOT NULL UNIQUE REFERENCES production_execution_jobs(id) ON DELETE CASCADE,
  item_id INT NOT NULL,
  raw_material_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  production_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  wastage_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  dispatch_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(16,4) NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(16,6) NOT NULL DEFAULT 0,
  produced_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  rejected_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_cost_snapshots_order_id
  ON production_cost_snapshots(order_id);
CREATE INDEX IF NOT EXISTS idx_production_cost_snapshots_created_at
  ON production_cost_snapshots(created_at DESC);

ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS packing_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS logistics_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS misc_cost NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Phase 15.5: minimal accountability columns (additive only)

ALTER TABLE dispatch_orders
  ADD COLUMN IF NOT EXISTS packed_by INT REFERENCES "user"(id),
  ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_by INT REFERENCES "user"(id);

ALTER TABLE service_tickets
  ADD COLUMN IF NOT EXISTS closed_by INT REFERENCES "user"(id),
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

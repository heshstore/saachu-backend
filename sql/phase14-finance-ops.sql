-- Phase 14 — operational finance (receivables, payables, payment log). Not accounting / GST / journals.
-- Run against the app database (synchronize=false).

CREATE TABLE IF NOT EXISTS customer_receivables (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  order_id INT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  total_order_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  received_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  outstanding_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  remarks TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_receivables_customer ON customer_receivables(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_receivables_status ON customer_receivables(status);

CREATE TABLE IF NOT EXISTS vendor_payables (
  id SERIAL PRIMARY KEY,
  vendor_id INT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  purchase_order_id INT NOT NULL UNIQUE REFERENCES purchase_orders(id) ON DELETE CASCADE,
  total_po_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  outstanding_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  remarks TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_payables_vendor ON vendor_payables(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payables_status ON vendor_payables(status);

CREATE TABLE IF NOT EXISTS payment_entries (
  id SERIAL PRIMARY KEY,
  payment_type VARCHAR(30) NOT NULL,
  reference_type VARCHAR(30),
  reference_id INT,
  customer_id INT REFERENCES customer(id) ON DELETE SET NULL,
  vendor_id INT REFERENCES vendors(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL,
  payment_mode VARCHAR(20) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  remarks TEXT,
  created_by INT REFERENCES "user"(id) ON DELETE SET NULL,
  linked_payment_id INT UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_entries_customer ON payment_entries(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_entries_vendor ON payment_entries(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_entries_type_date ON payment_entries(payment_type, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payment_entries_ref ON payment_entries(reference_type, reference_id);

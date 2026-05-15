-- Phase 13 — after-sales: service tickets, AMC, technicians (synchronize=false).
-- Spare stock movement uses inventory_transactions only (SERVICE_SPARE_USE).

CREATE SEQUENCE IF NOT EXISTS service_ticket_number_seq;

CREATE TABLE IF NOT EXISTS technician_profiles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  department VARCHAR(120),
  specialization VARCHAR(255),
  active BOOLEAN NOT NULL DEFAULT true,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS amc_contracts (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  order_id INT REFERENCES orders(id) ON DELETE SET NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  visit_frequency VARCHAR(40),
  covered_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amc_contracts_customer ON amc_contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_amc_contracts_end_date ON amc_contracts(end_date) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS service_tickets (
  id SERIAL PRIMARY KEY,
  ticket_number VARCHAR(40) NOT NULL UNIQUE,
  customer_id INT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  order_id INT REFERENCES orders(id) ON DELETE SET NULL,
  dispatch_order_id INT REFERENCES dispatch_orders(id) ON DELETE SET NULL,
  item_id INT NOT NULL REFERENCES service_items(id),
  issue_type VARCHAR(80),
  issue_description TEXT,
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  assigned_to INT REFERENCES "user"(id) ON DELETE SET NULL,
  service_type VARCHAR(30) NOT NULL,
  warranty_status VARCHAR(30),
  resolution_notes TEXT,
  created_by INT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_tickets_customer ON service_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_status ON service_tickets(status);
CREATE INDEX IF NOT EXISTS idx_service_tickets_assigned ON service_tickets(assigned_to);

CREATE TABLE IF NOT EXISTS service_ticket_updates (
  id SERIAL PRIMARY KEY,
  service_ticket_id INT NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  technician_id INT REFERENCES "user"(id) ON DELETE SET NULL,
  visit_notes TEXT,
  issue_findings TEXT,
  resolution_notes TEXT,
  next_action VARCHAR(255),
  created_by INT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_ticket_updates_ticket ON service_ticket_updates(service_ticket_id);

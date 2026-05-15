-- Phase 15 — operational workforce (not HRMS / payroll / compliance).

CREATE TABLE IF NOT EXISTS shift_master (
  id SERIAL PRIMARY KEY,
  shift_name VARCHAR(80) NOT NULL UNIQUE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  break_minutes INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shift_master (shift_name, start_time, end_time, break_minutes, active)
VALUES
  ('General', '09:00', '18:00', 60, true),
  ('Morning', '06:00', '14:00', 30, true),
  ('Night', '22:00', '06:00', 30, true)
ON CONFLICT (shift_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS employee_workforce_profiles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  employee_code VARCHAR(40) NOT NULL UNIQUE,
  department_id INT REFERENCES departments(id) ON DELETE SET NULL,
  designation TEXT,
  joining_date DATE,
  shift_master_id INT REFERENCES shift_master(id) ON DELETE SET NULL,
  shift_type VARCHAR(40),
  daily_working_hours NUMERIC(5,2) NOT NULL DEFAULT 8,
  overtime_eligible BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_profiles_dept ON employee_workforce_profiles(department_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_workforce_profiles_shift ON employee_workforce_profiles(shift_master_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  check_in_time TIMESTAMPTZ,
  check_out_time TIMESTAMPTZ,
  total_hours NUMERIC(6,2),
  overtime_hours NUMERIC(6,2),
  status VARCHAR(20) NOT NULL DEFAULT 'ABSENT',
  remarks TEXT,
  UNIQUE(user_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, attendance_date DESC);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  leave_type VARCHAR(20) NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  approved_by INT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status) WHERE status = 'PENDING';

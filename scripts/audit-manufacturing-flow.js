/**
 * Operational audit: seed minimal manufacturing master data + run API flow.
 * Run from backend: node scripts/audit-manufacturing-flow.js
 */
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcrypt');

const BASE = process.env.AUDIT_API_BASE || 'http://localhost:4000';
const SKU_RM = `AUDIT-RM-${Date.now()}`;
const SKU_FG = `AUDIT-FG-${Date.now()}`;

async function db() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}

async function ensureAdminPassword(c) {
  const pw = process.env.AUDIT_ADMIN_PASSWORD || 'Audit2026!';
  if (process.env.AUDIT_RESET_ADMIN_PW === '1') {
    const hash = await bcrypt.hash(pw, 10);
    await c.query('UPDATE "user" SET password_hash = $1 WHERE id = 2', [hash]);
  }
  return { email: 'heshstorebhavin@gmail.com', password: pw };
}

async function seedMaster(c) {
  await c.query(`
    INSERT INTO departments (name, code, active)
    SELECT 'Printing','PRINT', true WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'PRINT');
    INSERT INTO departments (name, code, active)
    SELECT 'Cutting','CUT', true WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'CUT');
    INSERT INTO departments (name, code, active)
    SELECT 'Packing','PACK', true WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'PACK');
  `);

  const depts = await c.query(
    `SELECT id, code FROM departments WHERE code IN ('PRINT','CUT','PACK') ORDER BY code`,
  );
  const d = {};
  for (const r of depts.rows) d[r.code] = r.id;

  await c.query(`
    INSERT INTO warehouses (name, code, type, active)
    SELECT 'Main Warehouse','MAINWH','GENERAL', true
    WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE code = 'MAINWH');
  `);
  const wh = await c.query(`SELECT id FROM warehouses WHERE code = 'MAINWH' LIMIT 1`);
  const warehouseId = wh.rows[0].id;

  const codeRm = (await c.query(`SELECT 'SVC-' || lpad(nextval('svc_item_code_seq')::text, 6, '0') AS c`)).rows[0].c;
  const codeFg = (await c.query(`SELECT 'SVC-' || lpad(nextval('svc_item_code_seq')::text, 6, '0') AS c`)).rows[0].c;

  const rmIns = await c.query(
    `INSERT INTO service_items (
       item_code, item_name, sku, hsn_code, gst, cost_price, selling_price, unit, source, is_active,
       main_category_type, service_subtype, boq_status, requires_production, requires_purchase,
       stock_tracking_type, is_raw_material
     ) VALUES ($1, $2, $3, '2501', 5, 10, 12, 'Nos', 'MANUAL', true,
       'TRADING', NULL, 'NOT_CREATED', false, true, 'PCS', true)
     RETURNING id`,
    [codeRm, 'Audit Raw Material Sheet', SKU_RM],
  );
  const rmId = rmIns.rows[0].id;

  const fgIns = await c.query(
    `INSERT INTO service_items (
       item_code, item_name, sku, hsn_code, gst, cost_price, selling_price, unit, source, is_active,
       main_category_type, service_subtype, boq_status, requires_production, requires_purchase,
       stock_tracking_type, is_raw_material
     ) VALUES ($1, $2, $3, '9405', 18, 100, 500, 'Nos', 'MANUAL', true,
       'MANUFACTURING', NULL, 'COMPLETE', true, true, 'PCS', false)
     RETURNING id`,
    [codeFg, 'Audit Finished Panel', SKU_FG],
  );
  const fgId = fgIns.rows[0].id;

  const boqIns = await c.query(
    `INSERT INTO manufacturing_boqs (item_id, version, status, notes, created_by)
     VALUES ($1, 1, 'ACTIVE', 'audit seed', 2) RETURNING id`,
    [fgId],
  );
  const boqId = boqIns.rows[0].id;

  await c.query(
    `INSERT INTO manufacturing_boq_items
       (boq_id, raw_material_item_id, department_id, consumption_type, qty_per_unit, wastage_percent)
     VALUES
       ($1, $2, $3, 'PCS', 2, 5),
       ($1, $2, $4, 'PCS', 2, 0),
       ($1, $2, $5, 'PCS', 2, 0)`,
    [boqId, rmId, d.PRINT, d.CUT, d.PACK],
  );

  await c.query(
    `INSERT INTO inventory_transactions
       (item_id, warehouse_id, transaction_type, direction, qty, unit, rate, reference_type, notes, created_by)
     VALUES ($1, $2, 'OPENING_STOCK', 'IN', 40, 'PCS', 10, 'MANUAL', 'audit opening', 2)`,
    [rmId, warehouseId],
  );

  await c.query(`UPDATE service_items SET boq_status = 'COMPLETE' WHERE id = $1`, [fgId]);

  return {
    warehouseId,
    rmId,
    fgId,
    boqId,
    deptIds: d,
    skus: { rm: SKU_RM, fg: SKU_FG },
  };
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { ok: r.ok, status: r.status, json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const c = await db();
  const admin = await ensureAdminPassword(c);
  const seed = await seedMaster(c);
  await c.end();

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: admin.email, password: admin.password },
  });
  if (!login.ok) {
    console.error('LOGIN FAIL', login.status, login.json);
    process.exit(1);
  }
  const token = login.json.access_token;

  const qBody = {
    customer_id: 1,
    status: 'GENERATED',
    items: [
      {
        sku: seed.skus.fg,
        item_name: 'Audit Finished Panel',
        qty: 10,
        rate: 500,
        gst_percent: 18,
        hsn_code: '9405',
      },
    ],
  };
  const q = await api('/quotations', { method: 'POST', token, body: qBody });
  if (!q.ok) {
    console.error('QUOTATION CREATE FAIL', q.status, q.json);
    process.exit(1);
  }
  const quotationId = q.json.id;

  const conv = await api(`/quotations/${quotationId}/convert-to-order`, { method: 'POST', token });
  if (!conv.ok) {
    console.error('CONVERT FAIL', conv.status, conv.json);
    process.exit(1);
  }
  const orderId = conv.json.order_id;

  await sleep(800);

  const omr = await api(`/orders/${orderId}/material-requirements`, { token });
  const wl = await api(`/orders/${orderId}/workloads`, { token });

  const sfa = await api(`/orders/${orderId}/send-for-approval`, {
    method: 'PATCH',
    token,
    body: {},
  });
  if (!sfa.ok) {
    console.error('SEND FOR APPROVAL FAIL', sfa.status, sfa.json);
    process.exit(1);
  }

  const appr = await api(`/orders/${orderId}/approve`, {
    method: 'PATCH',
    token,
    body: { remarks: 'audit approve' },
  });
  if (!appr.ok) {
    console.error('APPROVE FAIL', appr.status, appr.json);
    process.exit(1);
  }

  await sleep(1200);

  const jobs = await api('/production/execution/jobs', { token });
  const pr = await api(`/purchase-requirements?sourceId=${orderId}`, { token });

  const jobRow = (jobs.json || []).find((j) => Number(j.order_id) === orderId);
  let stageFlow = null;
  if (jobRow) {
    const jobDetail = await api(`/production/execution/jobs/${jobRow.id}`, { token });
    const stages = jobDetail.json?.stages || [];
    const s1 = stages[0];
    if (s1) {
      await api(`/production/execution/stages/${s1.id}/start`, { method: 'PATCH', token });
      await sleep(400);
      await api(`/production/execution/stages/${s1.id}/hold`, {
        method: 'PATCH',
        token,
        body: { reason: 'Machine warmup', remarks: 'audit hold' },
      });
      await sleep(300);
      await api(`/production/execution/stages/${s1.id}/resume`, { method: 'PATCH', token });
      await sleep(400);
      await api(`/production/execution/stages/${s1.id}/stop`, {
        method: 'PATCH',
        token,
        body: { completedQty: 10, rejectedQty: 0, remarks: 'audit stop' },
      });
      await sleep(200);
      const mn = await api(`/production/execution/stages/${s1.id}/move-next`, {
        method: 'PATCH',
        token,
      });
      const jd = await api(`/production/execution/jobs/${jobRow.id}`, { token });
      const s1After = (jd.json?.stages || []).find((x) => x.id === s1.id);
      const s2After = (jd.json?.stages || []).find((x) => x.sequence_no === 2);
      stageFlow = {
        moveNextOk: mn.ok,
        moveNextStatus: mn.status,
        s1: {
          status: s1After?.status,
          actualWorkingMinutes: s1After?.actual_working_minutes ?? s1After?.actualWorkingMinutes,
          totalHoldMinutes: s1After?.total_hold_minutes ?? s1After?.totalHoldMinutes,
          holdReason: s1After?.hold_reason ?? s1After?.holdReason,
          movedAt: s1After?.moved_at ?? s1After?.movedAt,
        },
        s2: { status: s2After?.status },
      };
    }
  }

  const c2 = await db();
  const counts = {};
  for (const t of [
    'manufacturing_boqs',
    'manufacturing_boq_items',
    'orders',
    'order_item',
    'order_material_requirements',
    'department_workloads',
    'purchase_requirements',
    'production_execution_jobs',
    'production_job_stages',
    'inventory_transactions',
    'warehouses',
    'departments',
  ]) {
    const r = await c2.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = r.rows[0].n;
  }
  await c2.end();

  console.log(
    JSON.stringify(
      {
        seed,
        orderId,
        quotationId,
        materialRequirementCount: Array.isArray(omr.json) ? omr.json.length : null,
        workloadCount: Array.isArray(wl.json) ? wl.json.length : null,
        purchaseRequirementCount: Array.isArray(pr.json) ? pr.json.length : null,
        purchaseSample: Array.isArray(pr.json) ? pr.json[0] : null,
        productionJobForOrder: jobRow || null,
        stageFlow,
        tableCounts: counts,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

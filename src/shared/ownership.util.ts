import { DataSource } from 'typeorm';

export interface UserDisplay {
  id: number;
  name: string;
  mobile: string | null;
  role: string;
}

/** Batch-load users for ownership display fields. */
export async function loadUsersByIds(
  ds: DataSource,
  ids: (number | null | undefined)[],
): Promise<Map<number, UserDisplay>> {
  const unique = [
    ...new Set(
      ids
        .filter((x) => x != null && Number.isFinite(Number(x)))
        .map((x) => Number(x)),
    ),
  ];
  if (!unique.length) return new Map();
  const rows: any[] = await ds.query(
    `SELECT id, name, mobile, role FROM "user" WHERE id = ANY($1)`,
    [unique],
  );
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        id: Number(r.id),
        name: String(r.name ?? ''),
        mobile: r.mobile ?? null,
        role: String(r.role ?? ''),
      },
    ]),
  );
}

/** Attach salesman_name / salesman_phone / salesman_role (+ legacy sales_person) from salesman_id. */
export function attachSalesmanFields(
  row: Record<string, any>,
  userMap: Map<number, UserDisplay>,
  idKey = 'salesman_id',
): void {
  const sid = row[idKey] ?? row.salesmanId;
  if (sid == null) {
    row.salesman_name = row.salesman_name ?? null;
    row.salesman_phone = row.salesman_phone ?? null;
    row.salesman_role = row.salesman_role ?? null;
    return;
  }
  const u = userMap.get(Number(sid));
  row.salesman_name = u?.name ?? row.salesman_name ?? null;
  row.salesman_phone = u?.mobile ?? row.salesman_phone ?? null;
  row.salesman_role = u?.role ?? row.salesman_role ?? null;
  if (u?.name) row.sales_person = u.name;
}

export async function enrichRowsWithSalesman(
  ds: DataSource,
  rows: any[],
  idKey = 'salesman_id',
): Promise<any[]> {
  const map = await loadUsersByIds(
    ds,
    rows.map((r) => r[idKey] ?? r.salesmanId),
  );
  for (const r of rows) attachSalesmanFields(r, map, idKey);
  return rows;
}

/** Attach approved_by_name / approved_by_role from orders.approved_by_id (entity field: approved_by). */
export function attachApproverFields(
  row: Record<string, any>,
  userMap: Map<number, UserDisplay>,
  idKey = 'approved_by',
): void {
  const aid = row[idKey] ?? row.approved_by_id;
  if (aid == null) {
    row.approved_by_name = row.approved_by_name ?? null;
    row.approved_by_role = row.approved_by_role ?? null;
    return;
  }
  const u = userMap.get(Number(aid));
  row.approved_by_name = u?.name ?? row.approved_by_name ?? null;
  row.approved_by_role = u?.role ?? row.approved_by_role ?? null;
}

export async function enrichRowsWithApprover(
  ds: DataSource,
  rows: any[],
  idKey = 'approved_by',
): Promise<any[]> {
  const map = await loadUsersByIds(
    ds,
    rows.map((r) => r[idKey] ?? r.approved_by_id),
  );
  for (const r of rows) attachApproverFields(r, map, idKey);
  return rows;
}

/** Batch: linked order approver for quotation list/detail payloads. */
export async function enrichQuotationsWithLinkedOrderApproval(
  ds: DataSource,
  rows: any[],
  orderIdKey = 'converted_order_id',
): Promise<void> {
  const linked = rows.filter((r) => r[orderIdKey] != null);
  if (!linked.length) return;
  const orderIds = linked.map((r) => Number(r[orderIdKey]));
  const approvalRows: any[] = await ds.query(
    `SELECT o.id AS order_id,
            o.order_no,
            o.approved_at,
            ab.name AS approved_by_name,
            ab.role AS approved_by_role
     FROM orders o
     LEFT JOIN "user" ab ON ab.id = o.approved_by_id
     WHERE o.id = ANY($1)`,
    [orderIds],
  );
  const byOrder = new Map(approvalRows.map((r) => [Number(r.order_id), r]));
  for (const row of linked) {
    const hit = byOrder.get(Number(row[orderIdKey]));
    if (!hit) continue;
    row.converted_order_no = hit.order_no;
    if (!hit.approved_by_name) continue;
    row.approved_by_name = hit.approved_by_name;
    row.approved_by_role = hit.approved_by_role;
    row.approved_at = hit.approved_at;
  }
}

/** Standard user display joins for production stages (operator + moved-by). */
export const STAGE_USER_SELECT = `
  au.name AS "operatorName",
  au.role AS "operatorRole",
  mu.name AS "movedByName",
  mu.role AS "movedByRole"
`;

export const STAGE_USER_JOINS = `
  LEFT JOIN "user" au ON au.id = pjs.assigned_user_id
  LEFT JOIN "user" mu ON mu.id = pjs.moved_by
`;

export const ORDER_SALESMAN_SELECT = `
  sm.name AS salesman_name,
  sm.mobile AS salesman_phone,
  sm.role AS salesman_role,
  ab.name AS approved_by_name,
  ab.role AS approved_by_role,
  o.approved_at AS approved_at,
  cb.name AS created_by_name,
  cb.role AS created_by_role
`;

export const ORDER_SALESMAN_JOINS = `
  LEFT JOIN "user" sm ON sm.id = o.salesman_id
  LEFT JOIN "user" ab ON ab.id = o.approved_by_id
  LEFT JOIN "user" cb ON cb.id = o.created_by
`;

export const DISPATCH_ACTOR_SELECT = `
  sm.name AS salesman_name,
  sm.mobile AS salesman_phone,
  sm.role AS salesman_role,
  pb.name AS packed_by_name,
  db.name AS dispatched_by_name,
  cb.name AS created_by_name
`;

export const DISPATCH_ACTOR_JOINS = `
  JOIN orders o ON o.id = d.order_id
  LEFT JOIN "user" sm ON sm.id = o.salesman_id
  LEFT JOIN "user" pb ON pb.id = d.packed_by
  LEFT JOIN "user" db ON db.id = d.dispatched_by
  LEFT JOIN "user" cb ON cb.id = d.created_by
`;

/** Batch-load customer email/name/mobile2 by customer id, for auto-filling "send email" flows and document previews. */
export async function loadCustomersByIds(
  ds: DataSource,
  ids: (number | null | undefined)[],
): Promise<
  Map<
    number,
    { email: string | null; companyName: string | null; mobile2: string | null }
  >
> {
  const unique = [
    ...new Set(
      ids
        .filter((x) => x != null && Number.isFinite(Number(x)))
        .map((x) => Number(x)),
    ),
  ];
  if (!unique.length) return new Map();
  const rows: any[] = await ds.query(
    `SELECT id, email, "companyName", mobile2 FROM customer WHERE id = ANY($1)`,
    [unique],
  );
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        email: r.email ?? null,
        companyName: r.companyName ?? null,
        mobile2: r.mobile2 ?? null,
      },
    ]),
  );
}

/** Attach customer_email/customer_mobile2 from customer_id — used to prefill "send by email" recipient fields and show secondary contact info on document previews. */
export async function enrichRowsWithCustomerEmail(
  ds: DataSource,
  rows: any[],
  idKey = 'customer_id',
): Promise<any[]> {
  const map = await loadCustomersByIds(
    ds,
    rows.map((r) => r[idKey]),
  );
  for (const r of rows) {
    const c = map.get(Number(r[idKey]));
    r.customer_email = c?.email ?? r.customer_email ?? null;
    r.customer_mobile2 = c?.mobile2 ?? r.customer_mobile2 ?? null;
  }
  return rows;
}

/** Attach email_sent_count — how many times this document has been successfully emailed. */
export async function enrichRowsWithEmailCount(
  ds: DataSource,
  rows: any[],
  entityType: 'quotation' | 'order' | 'invoice',
  idKey = 'id',
): Promise<any[]> {
  const ids = [
    ...new Set(
      rows
        .map((r) => r[idKey])
        .filter((x) => x != null && Number.isFinite(Number(x)))
        .map((x) => Number(x)),
    ),
  ];
  if (!ids.length) return rows;
  const counts: { entity_id: number; cnt: string }[] = await ds.query(
    `SELECT entity_id, COUNT(*) AS cnt
     FROM transactional_email_logs
     WHERE entity_type = $1 AND status = 'sent' AND entity_id = ANY($2)
     GROUP BY entity_id`,
    [entityType, ids],
  );
  const map = new Map(counts.map((c) => [Number(c.entity_id), Number(c.cnt)]));
  for (const r of rows) r.email_sent_count = map.get(Number(r[idKey])) ?? 0;
  return rows;
}

const ACTION_COUNT_FIELDS: Record<string, string> = {
  view: 'view_count',
  edit: 'edit_count',
  print: 'print_count',
  pdf: 'pdf_count',
  whatsapp: 'whatsapp_count',
};

/** Attach view_count / edit_count / print_count / pdf_count / whatsapp_count from document_action_log. */
export async function enrichRowsWithActionCounts(
  ds: DataSource,
  rows: any[],
  entityType: 'quotation' | 'order' | 'invoice',
  idKey = 'id',
): Promise<any[]> {
  for (const field of Object.values(ACTION_COUNT_FIELDS)) {
    for (const r of rows) r[field] = r[field] ?? 0;
  }
  const ids = [
    ...new Set(
      rows
        .map((r) => r[idKey])
        .filter((x) => x != null && Number.isFinite(Number(x)))
        .map((x) => Number(x)),
    ),
  ];
  if (!ids.length) return rows;
  const counts: { entity_id: number; action: string; cnt: string }[] =
    await ds.query(
      `SELECT entity_id, action, COUNT(*) AS cnt
       FROM document_action_log
       WHERE entity_type = $1 AND entity_id = ANY($2)
       GROUP BY entity_id, action`,
      [entityType, ids],
    );
  const byRow = new Map<number, Record<string, number>>();
  for (const c of counts) {
    const id = Number(c.entity_id);
    if (!byRow.has(id)) byRow.set(id, {});
    byRow.get(id)[c.action] = Number(c.cnt);
  }
  for (const r of rows) {
    const hit = byRow.get(Number(r[idKey]));
    if (!hit) continue;
    for (const [action, field] of Object.entries(ACTION_COUNT_FIELDS)) {
      if (hit[action] != null) r[field] = hit[action];
    }
  }
  return rows;
}

/** When a quotation is converted, surface order approver on the quotation payload. */
export async function attachLinkedOrderApproval(
  ds: DataSource,
  row: Record<string, any>,
  orderIdKey = 'converted_order_id',
): Promise<void> {
  await enrichQuotationsWithLinkedOrderApproval(ds, [row], orderIdKey);
}

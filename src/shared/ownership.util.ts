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
  const map = await loadUsersByIds(ds, rows.map((r) => r[idKey] ?? r.salesmanId));
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
    if (!hit?.approved_by_name) continue;
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

/** When a quotation is converted, surface order approver on the quotation payload. */
export async function attachLinkedOrderApproval(
  ds: DataSource,
  row: Record<string, any>,
  orderIdKey = 'converted_order_id',
): Promise<void> {
  await enrichQuotationsWithLinkedOrderApproval(ds, [row], orderIdKey);
}

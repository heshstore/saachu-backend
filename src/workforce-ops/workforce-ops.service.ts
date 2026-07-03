import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

type LeaveType = 'CASUAL' | 'SICK' | 'EMERGENCY' | 'UNPAID';
type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LEAVE' | 'HOLIDAY';

@Injectable()
export class WorkforceOpsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Local calendar date YYYY-MM-DD (server TZ). */
  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Resolve expected working hours from profile + shift_master. */
  private async getExpectedDailyHours(
    userId: number,
  ): Promise<{ hours: number; breakMins: number }> {
    const [p] = await this.ds.query(
      `SELECT ewp.daily_working_hours, ewp.shift_master_id,
              sm.start_time, sm.end_time, sm.break_minutes
       FROM employee_workforce_profiles ewp
       LEFT JOIN shift_master sm ON sm.id = ewp.shift_master_id AND sm.active = true
       WHERE ewp.user_id = $1 AND ewp.active = true
       LIMIT 1`,
      [userId],
    );
    if (!p) return { hours: 8, breakMins: 0 };
    const override = this.num(p.daily_working_hours);
    if (override > 0 && !p.start_time) return { hours: override, breakMins: 0 };

    if (p.start_time && p.end_time) {
      const mins = this.shiftSpanMinutes(
        String(p.start_time),
        String(p.end_time),
      );
      const br = Math.max(0, Math.round(this.num(p.break_minutes)));
      const h = Math.max(0.5, (mins - br) / 60);
      return { hours: h, breakMins: br };
    }
    return { hours: override > 0 ? override : 8, breakMins: 0 };
  }

  /** Parse PG time 'HH:MM:SS' or 'HH:MM'; return minutes from midnight. */
  private timeToMinutes(t: string): number {
    const parts = t.split(':').map((x) => parseInt(x, 10));
    const h = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    return h * 60 + m;
  }

  /** Duration in minutes between start and end (handles night shift). */
  private shiftSpanMinutes(startT: string, endT: string): number {
    const a = this.timeToMinutes(startT.slice(0, 8));
    const b = this.timeToMinutes(endT.slice(0, 8));
    if (b > a) return b - a;
    return 24 * 60 - a + b;
  }

  async assertStaffEdit(role: string | undefined): Promise<void> {
    if (role === 'Admin' || role === 'COO') return;
    const rows = await this.ds.query(
      `SELECT 1 FROM role r
       JOIN role_permission rp ON rp.role_id = r.id
       JOIN permission p ON p.id = rp.permission_id
       WHERE r.name = $1 AND p.key = 'staff.edit' LIMIT 1`,
      [role],
    );
    if (!rows.length) throw new ForbiddenException('staff.edit required');
  }

  // ── Shift master ───────────────────────────────────────────────────────────

  async listShifts(activeOnly = true) {
    const q = activeOnly
      ? `SELECT * FROM shift_master WHERE active = true ORDER BY shift_name`
      : `SELECT * FROM shift_master ORDER BY shift_name`;
    return this.ds.query(q);
  }

  async createShift(body: {
    shiftName: string;
    startTime: string;
    endTime: string;
    breakMinutes?: number;
  }) {
    const r = await this.ds.query(
      `INSERT INTO shift_master (shift_name, start_time, end_time, break_minutes)
       VALUES ($1, $2::time, $3::time, $4)
       RETURNING *`,
      [
        body.shiftName.trim(),
        body.startTime,
        body.endTime,
        body.breakMinutes ?? 0,
      ],
    );
    return r[0];
  }

  async updateShift(
    id: number,
    body: Partial<{
      shiftName: string;
      startTime: string;
      endTime: string;
      breakMinutes: number;
      active: boolean;
    }>,
  ) {
    const [cur] = await this.ds.query(
      `SELECT * FROM shift_master WHERE id = $1`,
      [id],
    );
    if (!cur) throw new NotFoundException('Shift not found');
    await this.ds.query(
      `UPDATE shift_master SET
         shift_name = COALESCE($2, shift_name),
         start_time = COALESCE($3::time, start_time),
         end_time = COALESCE($4::time, end_time),
         break_minutes = COALESCE($5, break_minutes),
         active = COALESCE($6, active),
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        body.shiftName ?? null,
        body.startTime ?? null,
        body.endTime ?? null,
        body.breakMinutes ?? null,
        body.active ?? null,
      ],
    );
    const [u] = await this.ds.query(
      `SELECT * FROM shift_master WHERE id = $1`,
      [id],
    );
    return u;
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  async listProfiles() {
    return this.ds.query(`
      SELECT ewp.*, u.name AS user_name, u.email AS user_email, d.name AS department_name, d.code AS department_code,
             sm.shift_name
      FROM employee_workforce_profiles ewp
      JOIN "user" u ON u.id = ewp.user_id
      LEFT JOIN departments d ON d.id = ewp.department_id
      LEFT JOIN shift_master sm ON sm.id = ewp.shift_master_id
      ORDER BY ewp.employee_code
    `);
  }

  async createProfile(body: {
    userId: number;
    employeeCode: string;
    departmentId?: number | null;
    designation?: string;
    joiningDate?: string | null;
    shiftMasterId?: number | null;
    shiftType?: string | null;
    dailyWorkingHours?: number;
    overtimeEligible?: boolean;
  }) {
    const [exists] = await this.ds.query(
      `SELECT 1 FROM employee_workforce_profiles WHERE user_id = $1`,
      [body.userId],
    );
    if (exists)
      throw new BadRequestException(
        'Workforce profile already exists for this user',
      );
    const r = await this.ds.query(
      `INSERT INTO employee_workforce_profiles
        (user_id, employee_code, department_id, designation, joining_date, shift_master_id, shift_type, daily_working_hours, overtime_eligible)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, COALESCE($8, 8), COALESCE($9, true))
       RETURNING *`,
      [
        body.userId,
        body.employeeCode.trim(),
        body.departmentId ?? null,
        body.designation ?? null,
        body.joiningDate ?? null,
        body.shiftMasterId ?? null,
        body.shiftType ?? null,
        body.dailyWorkingHours ?? null,
        body.overtimeEligible ?? null,
      ],
    );
    return r[0];
  }

  async updateProfile(
    id: number,
    body: Partial<{
      employeeCode: string;
      departmentId: number | null;
      designation: string | null;
      joiningDate: string | null;
      shiftMasterId: number | null;
      shiftType: string | null;
      dailyWorkingHours: number;
      overtimeEligible: boolean;
      active: boolean;
    }>,
  ) {
    const [cur] = await this.ds.query(
      `SELECT * FROM employee_workforce_profiles WHERE id = $1`,
      [id],
    );
    if (!cur) throw new NotFoundException('Profile not found');
    const m = {
      employee_code: body.employeeCode ?? cur.employee_code,
      department_id:
        body.departmentId !== undefined ? body.departmentId : cur.department_id,
      designation:
        body.designation !== undefined ? body.designation : cur.designation,
      joining_date:
        body.joiningDate !== undefined ? body.joiningDate : cur.joining_date,
      shift_master_id:
        body.shiftMasterId !== undefined
          ? body.shiftMasterId
          : cur.shift_master_id,
      shift_type:
        body.shiftType !== undefined ? body.shiftType : cur.shift_type,
      daily_working_hours: body.dailyWorkingHours ?? cur.daily_working_hours,
      overtime_eligible: body.overtimeEligible ?? cur.overtime_eligible,
      active: body.active ?? cur.active,
    };
    await this.ds.query(
      `UPDATE employee_workforce_profiles SET
         employee_code = $2,
         department_id = $3,
         designation = $4,
         joining_date = $5::date,
         shift_master_id = $6,
         shift_type = $7,
         daily_working_hours = $8,
         overtime_eligible = $9,
         active = $10,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        m.employee_code,
        m.department_id,
        m.designation,
        m.joining_date,
        m.shift_master_id,
        m.shift_type,
        m.daily_working_hours,
        m.overtime_eligible,
        m.active,
      ],
    );
    const [u] = await this.ds.query(
      `SELECT * FROM employee_workforce_profiles WHERE id = $1`,
      [id],
    );
    return u;
  }

  // ── Attendance ─────────────────────────────────────────────────────────────

  async getMyToday(userId: number) {
    const d = this.todayStr();
    const [row] = await this.ds.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND attendance_date = $2::date`,
      [userId, d],
    );
    // Always return a serializable object so clients never see 200 + empty body (breaks response.json()).
    return row ?? {};
  }

  async listAttendance(filters: { date?: string; userId?: number } = {}) {
    const date = filters.date || this.todayStr();
    const params: unknown[] = [date];
    let cond = `ar.attendance_date = $1::date`;
    if (filters.userId) {
      params.push(filters.userId);
      cond += ` AND ar.user_id = $${params.length}`;
    }
    return this.ds.query(
      `SELECT ar.*, u.name AS user_name
       FROM attendance_records ar
       JOIN "user" u ON u.id = ar.user_id
       WHERE ${cond}
       ORDER BY u.name`,
      params,
    );
  }

  async checkIn(actor: { id: number; role?: string }, targetUserId?: number) {
    const uid = targetUserId ?? actor.id;
    if (targetUserId && targetUserId !== actor.id) {
      await this.assertStaffEdit(actor.role);
    }
    const d = this.todayStr();
    const now = new Date();
    const [existing] = await this.ds.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND attendance_date = $2::date`,
      [uid, d],
    );
    if (existing?.check_in_time && !existing?.check_out_time) {
      throw new BadRequestException('Already checked in; check out first');
    }
    if (existing?.check_out_time) {
      throw new BadRequestException('Attendance already completed for today');
    }
    const rows = await this.ds.query(
      `INSERT INTO attendance_records (user_id, attendance_date, check_in_time, status)
       VALUES ($1, $2::date, $3, 'PRESENT')
       ON CONFLICT (user_id, attendance_date) DO UPDATE SET
         check_in_time = EXCLUDED.check_in_time,
         check_out_time = NULL,
         total_hours = NULL,
         overtime_hours = NULL,
         status = 'PRESENT',
         remarks = attendance_records.remarks
       RETURNING *`,
      [uid, d, now],
    );
    return rows[0];
  }

  async checkOut(actor: { id: number; role?: string }, targetUserId?: number) {
    const uid = targetUserId ?? actor.id;
    if (targetUserId && targetUserId !== actor.id) {
      await this.assertStaffEdit(actor.role);
    }
    const d = this.todayStr();
    const now = new Date();
    const [row] = await this.ds.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND attendance_date = $2::date FOR UPDATE`,
      [uid, d],
    );
    if (!row?.check_in_time) throw new BadRequestException('Check in first');
    if (row.check_out_time)
      throw new BadRequestException('Already checked out');

    const { hours: expected } = await this.getExpectedDailyHours(uid);
    const [p] = await this.ds.query(
      `SELECT overtime_eligible FROM employee_workforce_profiles WHERE user_id = $1 AND active = true`,
      [uid],
    );
    const otEligible = p ? Boolean(p.overtime_eligible) : true;

    const tIn = new Date(row.check_in_time).getTime();
    const tOut = now.getTime();
    const rawH = Math.max(0, (tOut - tIn) / 3_600_000);
    const totalH = Math.round(rawH * 100) / 100;
    let overtimeH = Math.max(0, Math.round((totalH - expected) * 100) / 100);
    if (!otEligible) overtimeH = 0;

    const [u] = await this.ds.query(
      `UPDATE attendance_records SET
         check_out_time = $2,
         total_hours = $3,
         overtime_hours = $4,
         status = CASE WHEN $3 < $5 * 0.5 THEN 'HALF_DAY' ELSE 'PRESENT' END
       WHERE id = $1
       RETURNING *`,
      [row.id, now, totalH, overtimeH, expected],
    );
    return u;
  }

  /** Manual row (e.g. mark holiday) — staff.edit */
  async upsertAttendanceAdmin(body: {
    userId: number;
    attendanceDate: string;
    status: AttendanceStatus;
    checkInTime?: string | null;
    checkOutTime?: string | null;
    remarks?: string | null;
  }) {
    const expected = (await this.getExpectedDailyHours(body.userId)).hours;
    let totalH: number | null = null;
    let otH: number | null = null;
    if (body.checkInTime && body.checkOutTime) {
      const tIn = new Date(body.checkInTime).getTime();
      const tOut = new Date(body.checkOutTime).getTime();
      totalH = Math.round(Math.max(0, (tOut - tIn) / 3_600_000) * 100) / 100;
      otH = Math.max(0, Math.round((totalH - expected) * 100) / 100);
    }
    const r = await this.ds.query(
      `INSERT INTO attendance_records
        (user_id, attendance_date, check_in_time, check_out_time, total_hours, overtime_hours, status, remarks)
       VALUES ($1, $2::date, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8)
       ON CONFLICT (user_id, attendance_date) DO UPDATE SET
         check_in_time = EXCLUDED.check_in_time,
         check_out_time = EXCLUDED.check_out_time,
         total_hours = EXCLUDED.total_hours,
         overtime_hours = EXCLUDED.overtime_hours,
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks
       RETURNING *`,
      [
        body.userId,
        body.attendanceDate,
        body.checkInTime ?? null,
        body.checkOutTime ?? null,
        totalH,
        otH,
        body.status,
        body.remarks ?? null,
      ],
    );
    return r[0];
  }

  // ── Leave ───────────────────────────────────────────────────────────────────

  async listLeaves(filters: { status?: string; userId?: number } = {}) {
    const params: unknown[] = [];
    const cond: string[] = ['1=1'];
    if (filters.status) {
      params.push(filters.status);
      cond.push(`lr.status = $${params.length}`);
    }
    if (filters.userId) {
      params.push(filters.userId);
      cond.push(`lr.user_id = $${params.length}`);
    }
    return this.ds.query(
      `SELECT lr.*, u.name AS user_name,
              a.name AS approved_by_name
       FROM leave_requests lr
       JOIN "user" u ON u.id = lr.user_id
       LEFT JOIN "user" a ON a.id = lr.approved_by
       WHERE ${cond.join(' AND ')}
       ORDER BY lr.created_at DESC
       LIMIT 300`,
      params,
    );
  }

  async createLeave(
    actorId: number,
    body: {
      leaveType: LeaveType;
      fromDate: string;
      toDate: string;
      reason?: string;
    },
  ) {
    if (new Date(body.toDate) < new Date(body.fromDate)) {
      throw new BadRequestException('toDate must be on or after fromDate');
    }
    const r = await this.ds.query(
      `INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, reason, status)
       VALUES ($1, $2, $3::date, $4::date, $5, 'PENDING')
       RETURNING *`,
      [
        actorId,
        body.leaveType,
        body.fromDate,
        body.toDate,
        body.reason ?? null,
      ],
    );
    return r[0];
  }

  private async applyLeaveToAttendance(
    userId: number,
    fromD: string,
    toD: string,
  ): Promise<void> {
    const start = new Date(fromD + 'T12:00:00');
    const end = new Date(toD + 'T12:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      await this.ds.query(
        `INSERT INTO attendance_records (user_id, attendance_date, status, check_in_time, check_out_time, total_hours, overtime_hours)
         VALUES ($1, $2::date, 'LEAVE', NULL, NULL, NULL, NULL)
         ON CONFLICT (user_id, attendance_date) DO UPDATE SET
           status = 'LEAVE',
           check_in_time = NULL,
           check_out_time = NULL,
           total_hours = NULL,
           overtime_hours = NULL`,
        [userId, ds],
      );
    }
  }

  async setLeaveStatus(
    id: number,
    status: 'APPROVED' | 'REJECTED',
    approverId: number | null,
    role: string | undefined,
  ) {
    await this.assertStaffEdit(role);
    const [lr] = await this.ds.query(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );
    if (!lr) throw new NotFoundException('Leave request not found');
    if (lr.status !== 'PENDING') {
      throw new BadRequestException(
        'Only pending requests can be approved or rejected',
      );
    }
    await this.ds.query(
      `UPDATE leave_requests SET status = $2, approved_by = $3, updated_at = now() WHERE id = $1`,
      [id, status, approverId],
    );
    if (status === 'APPROVED') {
      const fromStr =
        lr.from_date instanceof Date
          ? lr.from_date.toISOString().slice(0, 10)
          : String(lr.from_date).slice(0, 10);
      const toStr =
        lr.to_date instanceof Date
          ? lr.to_date.toISOString().slice(0, 10)
          : String(lr.to_date).slice(0, 10);
      await this.applyLeaveToAttendance(lr.user_id, fromStr, toStr);
    }
    const [u] = await this.ds.query(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );
    return u;
  }

  async cancelOwnLeave(id: number, userId: number) {
    const [lr] = await this.ds.query(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );
    if (!lr) throw new NotFoundException('Leave request not found');
    if (lr.user_id !== userId)
      throw new ForbiddenException('Not your leave request');
    if (lr.status !== 'PENDING')
      throw new BadRequestException('Only pending can be cancelled');
    await this.ds.query(
      `UPDATE leave_requests SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [id],
    );
    const [u] = await this.ds.query(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );
    return u;
  }

  // ── Dashboards & analytics ─────────────────────────────────────────────────

  async getDashboard() {
    const today = this.todayStr();
    const [present] = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM attendance_records
       WHERE attendance_date = $1::date AND status IN ('PRESENT','HALF_DAY') AND check_in_time IS NOT NULL`,
      [today],
    );
    const [absent] = await this.ds.query(
      `SELECT COUNT(*)::int AS c
       FROM employee_workforce_profiles ewp
       JOIN "user" u ON u.id = ewp.user_id AND u.is_active = true
       WHERE ewp.active = true
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records ar
           WHERE ar.user_id = ewp.user_id AND ar.attendance_date = $1::date
             AND ar.status IN ('PRESENT','HALF_DAY','LEAVE','HOLIDAY')
         )`,
      [today],
    );
    const [tech] = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM technician_profiles WHERE active = true`,
    );
    const [pendingLeaves] = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM leave_requests WHERE status = 'PENDING'`,
    );
    const [ot] = await this.ds.query(
      `SELECT COALESCE(SUM(overtime_hours), 0)::numeric AS h
       FROM attendance_records WHERE attendance_date = $1::date`,
      [today],
    );
    const deptRows = await this.ds.query(
      `
      SELECT d.id, d.name, d.code, d.manpower_capacity,
        (SELECT COUNT(DISTINCT ewp.user_id)
         FROM employee_workforce_profiles ewp
         JOIN attendance_records ar ON ar.user_id = ewp.user_id AND ar.attendance_date = $1::date
           AND ar.status IN ('PRESENT','HALF_DAY')
         WHERE ewp.department_id = d.id AND ewp.active = true) AS present_today
      FROM departments d
      WHERE d.active = true
      ORDER BY d.name
    `,
      [today],
    );

    const overload = await this.ds.query(`
      SELECT d.id, d.name, d.manpower_capacity,
        COUNT(DISTINCT pej.id) AS open_jobs
      FROM departments d
      LEFT JOIN production_job_stages pjs ON pjs.department_id = d.id
      LEFT JOIN production_execution_jobs pej ON pej.id = pjs.production_job_id
        AND pej.status IN ('PENDING','READY','IN_PROGRESS','HOLD')
      WHERE d.active = true AND d.manpower_capacity IS NOT NULL
      GROUP BY d.id, d.name, d.manpower_capacity
      HAVING COUNT(DISTINCT pej.id) > d.manpower_capacity
      ORDER BY open_jobs DESC
    `);

    return {
      date: today,
      presentCount: this.num(present?.c),
      absentCount: this.num(absent?.c),
      activeTechnicians: this.num(tech?.c),
      pendingLeaveRequests: this.num(pendingLeaves?.c),
      overtimeHoursToday: this.num(ot?.h),
      workforceUtilizationPct:
        this.num(absent?.c) + this.num(present?.c) > 0
          ? Math.round(
              (this.num(present?.c) /
                (this.num(present?.c) + this.num(absent?.c))) *
                1000,
            ) / 10
          : 0,
      departmentsToday: deptRows,
      overloadedDepartments: overload,
    };
  }

  async getAvailability() {
    const today = this.todayStr();
    const presentEmployees = await this.ds.query(
      `SELECT ar.*, u.name AS user_name, ewp.employee_code, d.name AS department_name
       FROM attendance_records ar
       JOIN "user" u ON u.id = ar.user_id
       LEFT JOIN employee_workforce_profiles ewp ON ewp.user_id = ar.user_id
       LEFT JOIN departments d ON d.id = ewp.department_id
       WHERE ar.attendance_date = $1::date AND ar.status IN ('PRESENT','HALF_DAY') AND ar.check_in_time IS NOT NULL
       ORDER BY u.name`,
      [today],
    );
    const absentEmployees = await this.absentTodayList();
    return { date: today, presentEmployees, absentEmployees };
  }

  async getProductivity(filters: { from?: string; to?: string } = {}) {
    const from =
      filters.from ||
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = filters.to || this.todayStr();

    const [stages] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS stages_completed,
         COALESCE(AVG(actual_working_minutes) FILTER (WHERE status = 'COMPLETED'), 0)::numeric AS avg_working_min,
         COUNT(*) FILTER (WHERE total_hold_minutes > 0 OR status = 'ON_HOLD')::int AS hold_events
       FROM production_job_stages
       WHERE COALESCE(completed_at::date, updated_at::date) BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const [att] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY'))::int AS present_rows,
         COUNT(*)::int AS total_rows,
         COALESCE(SUM(overtime_hours), 0)::numeric AS overtime_hours
       FROM attendance_records
       WHERE attendance_date BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const [tickets] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved
       FROM service_tickets
       WHERE COALESCE(resolved_at::date, updated_at::date) BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    const present = this.num(att?.present_rows);
    const totalA = this.num(att?.total_rows);
    const attPct = totalA > 0 ? Math.round((present / totalA) * 1000) / 10 : 0;
    const otH = this.num(att?.overtime_hours);
    const otPct =
      present > 0 ? Math.round((otH / (present * 8 + 0.001)) * 1000) / 10 : 0;

    return {
      from,
      to,
      productionJobStagesCompleted: this.num(stages?.stages_completed),
      avgWorkingMinutesCompletedStages: this.num(stages?.avg_working_min),
      stageHoldOrHoldMinutesCount: this.num(stages?.hold_events),
      attendancePresentRatioPct: attPct,
      overtimeHoursInPeriod: otH,
      roughOvertimeLoadPct: otPct,
      serviceTicketsResolved: this.num(tickets?.resolved),
    };
  }

  async getPayrollInputSummary(userId: number, year: number, month: number) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const next =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const [a] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY'))::int AS working_day_rows,
         COUNT(*) FILTER (WHERE status = 'HALF_DAY')::int AS half_days,
         COALESCE(SUM(total_hours), 0)::numeric AS total_hours,
         COALESCE(SUM(overtime_hours), 0)::numeric AS overtime_hours
       FROM attendance_records
       WHERE user_id = $1 AND attendance_date >= $2::date AND attendance_date < $3::date`,
      [userId, start, next],
    );

    const leaves = await this.ds.query(
      `SELECT from_date, to_date FROM leave_requests
       WHERE user_id = $1 AND status = 'APPROVED'
         AND to_date >= $2::date AND from_date < $3::date`,
      [userId, start, next],
    );
    const monthEnd = new Date(next);
    monthEnd.setDate(monthEnd.getDate() - 1);
    const leaveDaysSet = new Set<string>();
    for (const lr of leaves) {
      const fromStr =
        lr.from_date instanceof Date
          ? lr.from_date.toISOString().slice(0, 10)
          : String(lr.from_date).slice(0, 10);
      const toStr =
        lr.to_date instanceof Date
          ? lr.to_date.toISOString().slice(0, 10)
          : String(lr.to_date).slice(0, 10);
      const segStart = new Date(
        Math.max(new Date(fromStr).getTime(), new Date(start).getTime()),
      );
      const segEnd = new Date(
        Math.min(new Date(toStr).getTime(), monthEnd.getTime()),
      );
      for (
        let d = new Date(segStart);
        d <= segEnd;
        d.setDate(d.getDate() + 1)
      ) {
        leaveDaysSet.add(d.toISOString().slice(0, 10));
      }
    }
    const leaveDays = leaveDaysSet.size;

    const workingRows = this.num(a?.working_day_rows);
    const half = this.num(a?.half_days);
    const calendarDays = Math.round(
      (new Date(next).getTime() - new Date(start).getTime()) / 86400000,
    );
    const attendancePct =
      calendarDays > 0
        ? Math.round((workingRows / calendarDays) * 1000) / 10
        : 0;
    const payableDays = Math.max(0, workingRows - half * 0.5);

    return {
      userId,
      period: { year, month, start, endExclusive: next },
      workingDayRows: workingRows,
      halfDayRows: half,
      leaveDaysApprovedOverlap: leaveDays,
      totalHoursRecorded: this.num(a?.total_hours),
      overtimeHours: this.num(a?.overtime_hours),
      attendancePctVsCalendar: attendancePct,
      payableDaysApprox: Math.round(payableDays * 10) / 10,
      disclaimer: 'Operational inputs only — not salary or statutory payroll.',
    };
  }

  async absentTodayList() {
    const today = this.todayStr();
    return this.ds.query(
      `SELECT u.id, u.name, u.email, ewp.employee_code, d.name AS department_name
       FROM employee_workforce_profiles ewp
       JOIN "user" u ON u.id = ewp.user_id AND u.is_active = true
       LEFT JOIN departments d ON d.id = ewp.department_id
       WHERE ewp.active = true
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records ar
           WHERE ar.user_id = ewp.user_id AND ar.attendance_date = $1::date
             AND ar.status IN ('PRESENT','HALF_DAY','LEAVE','HOLIDAY')
         )
       ORDER BY u.name`,
      [today],
    );
  }
}

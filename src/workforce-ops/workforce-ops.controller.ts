import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RequirePermission } from '../auth/require-permission.decorator';
import { WorkforceOpsService } from './workforce-ops.service';

@Controller('workforce-ops')
export class WorkforceOpsController {
  constructor(private readonly svc: WorkforceOpsService) {}

  // ── Self-service attendance (any authenticated user) ───────────────────────

  @Get('attendance/me/today')
  myToday(@Req() req: { user: { id: number } }) {
    return this.svc.getMyToday(req.user.id);
  }

  @Post('attendance/me/check-in')
  checkInMe(@Req() req: { user: { id: number; role?: string } }) {
    return this.svc.checkIn({ id: req.user.id, role: req.user.role });
  }

  @Post('attendance/me/check-out')
  checkOutMe(@Req() req: { user: { id: number; role?: string } }) {
    return this.svc.checkOut({ id: req.user.id, role: req.user.role });
  }

  @Post('attendance/check-in')
  @RequirePermission('staff.edit')
  checkInAdmin(
    @Req() req: { user: { id: number; role?: string } },
    @Body() body: { userId: number },
  ) {
    return this.svc.checkIn(
      { id: req.user.id, role: req.user.role },
      body.userId,
    );
  }

  @Post('attendance/check-out')
  @RequirePermission('staff.edit')
  checkOutAdmin(
    @Req() req: { user: { id: number; role?: string } },
    @Body() body: { userId: number },
  ) {
    return this.svc.checkOut(
      { id: req.user.id, role: req.user.role },
      body.userId,
    );
  }

  @Get('attendance')
  @RequirePermission('staff.view')
  listAttendance(
    @Query('date') date?: string,
    @Query('userId') userId?: string,
  ) {
    return this.svc.listAttendance({
      date: date || undefined,
      userId: userId ? Number(userId) : undefined,
    });
  }

  @Post('attendance/manual')
  @RequirePermission('staff.edit')
  upsertAttendance(
    @Body()
    body: {
      userId: number;
      attendanceDate: string;
      status: string;
      checkInTime?: string | null;
      checkOutTime?: string | null;
      remarks?: string | null;
    },
  ) {
    return this.svc.upsertAttendanceAdmin(body as any);
  }

  // ── Shifts ─────────────────────────────────────────────────────────────────

  @Get('shifts')
  @RequirePermission('staff.view')
  listShifts(@Query('all') all?: string) {
    return this.svc.listShifts(all !== '1' && all !== 'true');
  }

  @Post('shifts')
  @RequirePermission('staff.edit')
  createShift(
    @Body()
    body: {
      shiftName: string;
      startTime: string;
      endTime: string;
      breakMinutes?: number;
    },
  ) {
    return this.svc.createShift(body);
  }

  @Patch('shifts/:id')
  @RequirePermission('staff.edit')
  updateShift(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.updateShift(id, body as any);
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  @Get('profiles')
  @RequirePermission('staff.view')
  listProfiles() {
    return this.svc.listProfiles();
  }

  @Post('profiles')
  @RequirePermission('staff.edit')
  createProfile(@Body() body: Record<string, unknown>) {
    return this.svc.createProfile(body as any);
  }

  @Patch('profiles/:id')
  @RequirePermission('staff.edit')
  updateProfile(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.updateProfile(id, body as any);
  }

  // ── Leave ───────────────────────────────────────────────────────────────────

  @Get('leave-requests')
  @RequirePermission('staff.view')
  listLeaves(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
  ) {
    return this.svc.listLeaves({
      status: status || undefined,
      userId: userId ? Number(userId) : undefined,
    });
  }

  @Get('leave-requests/mine')
  myLeaves(@Req() req: { user: { id: number } }) {
    return this.svc.listLeaves({ userId: req.user.id });
  }

  @Post('leave-requests')
  createLeave(
    @Req() req: { user: { id: number } },
    @Body()
    body: {
      leaveType: string;
      fromDate: string;
      toDate: string;
      reason?: string;
    },
  ) {
    return this.svc.createLeave(req.user.id, body as any);
  }

  @Post('leave-requests/:id/approve')
  @RequirePermission('staff.edit')
  approveLeave(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: { id: number; role?: string } },
  ) {
    return this.svc.setLeaveStatus(id, 'APPROVED', req.user.id, req.user.role);
  }

  @Post('leave-requests/:id/reject')
  @RequirePermission('staff.edit')
  rejectLeave(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: { id: number; role?: string } },
  ) {
    return this.svc.setLeaveStatus(id, 'REJECTED', req.user.id, req.user.role);
  }

  @Post('leave-requests/:id/cancel')
  cancelLeave(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: { id: number } },
  ) {
    return this.svc.cancelOwnLeave(id, req.user.id);
  }

  // ── Dashboards & analytics ───────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermission('staff.view')
  dashboard() {
    return this.svc.getDashboard();
  }

  @Get('availability')
  @RequirePermission('staff.view')
  availability() {
    return this.svc.getAvailability();
  }

  @Get('productivity')
  @RequirePermission('staff.view')
  productivity(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.getProductivity({ from, to });
  }

  @Get('payroll-input/:userId')
  @RequirePermission('staff.view')
  payrollInput(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    const y = year ? Number(year) : new Date().getFullYear();
    const m = month ? Number(month) : new Date().getMonth() + 1;
    return this.svc.getPayrollInputSummary(userId, y, m);
  }

  @Get('absent-today')
  @RequirePermission('staff.view')
  absentToday() {
    return this.svc.absentTodayList();
  }
}

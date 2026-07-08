import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ProductionBoardService } from './production-board.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('production/board')
export class ProductionBoardController {
  constructor(private readonly svc: ProductionBoardService) {}

  // ── Dashboard ──────────────────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermission('production.view')
  getDashboard() {
    return this.svc.getDashboard();
  }

  // ── Board view (all columns) ───────────────────────────────────────────────

  @Get('items')
  @RequirePermission('production.view')
  getBoardView(
    @Query('orderId') orderId?: string,
    @Query('priority') priority?: string,
    @Query('stage') stage?: string,
  ) {
    return this.svc.getBoardView({
      orderId: orderId ? +orderId : undefined,
      priority,
      stage,
    });
  }

  // ── Single task detail ─────────────────────────────────────────────────────

  @Get('tasks/:taskId')
  @RequirePermission('production.view')
  getTask(@Param('taskId') taskId: string) {
    return this.svc.getTask(+taskId);
  }

  // ── Order item history ─────────────────────────────────────────────────────

  @Get('order-items/:orderItemId/history')
  @RequirePermission('production.view')
  getItemHistory(@Param('orderItemId') orderItemId: string) {
    return this.svc.getItemHistory(+orderItemId);
  }

  // ── Seed board for an already-approved order (idempotent) ─────────────────

  @Post('generate/:orderId')
  @RequirePermission('production.update')
  generateForOrder(@Param('orderId') orderId: string) {
    return this.svc.generateForOrder(+orderId);
  }

  // ── Manager: assign department ─────────────────────────────────────────────

  @Post('order-items/:orderItemId/assign')
  @RequirePermission('production.assign')
  assignDepartment(
    @Param('orderItemId') orderItemId: string,
    @Body() body: { departmentId: number; dependsOn?: number[]; remarks?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.svc.assignDepartment(
      +orderItemId,
      body.departmentId,
      userId,
      { dependsOn: body.dependsOn, remarks: body.remarks },
    );
  }

  // ── Manager: send to packing ───────────────────────────────────────────────

  @Post('order-items/:orderItemId/packing')
  @RequirePermission('production.assign')
  moveToPacking(
    @Param('orderItemId') orderItemId: string,
    @Body() body: { remarks?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.svc.moveToPacking(+orderItemId, userId, body.remarks);
  }

  // ── Manager: send to billing ───────────────────────────────────────────────

  @Post('order-items/:orderItemId/billing')
  @RequirePermission('production.assign')
  moveToReadyForBilling(
    @Param('orderItemId') orderItemId: string,
    @Body() body: { remarks?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.svc.moveToReadyForBilling(+orderItemId, userId, body.remarks);
  }

  // ── Manager: hold / cancel / priority ─────────────────────────────────────

  @Patch('tasks/:taskId/hold')
  @RequirePermission('production.update')
  holdItem(
    @Param('taskId') taskId: string,
    @Body() body: { remarks?: string },
  ) {
    return this.svc.holdItem(+taskId, body.remarks);
  }

  @Patch('tasks/:taskId/cancel')
  @RequirePermission('production.update')
  cancelTask(
    @Param('taskId') taskId: string,
    @Body() body: { remarks?: string },
  ) {
    return this.svc.cancelTask(+taskId, body.remarks);
  }

  @Patch('order-items/:orderItemId/priority')
  @RequirePermission('production.update')
  changePriority(
    @Param('orderItemId') orderItemId: string,
    @Body() body: { priority: string },
  ) {
    return this.svc.changePriority(+orderItemId, body.priority);
  }

  // ── Department workspace ───────────────────────────────────────────────────

  @Get('dept/:departmentId/queue')
  @RequirePermission('production.view')
  getDeptQueue(@Param('departmentId') departmentId: string) {
    return this.svc.getDeptQueue(+departmentId);
  }

  @Get('dept/:departmentId/dashboard')
  @RequirePermission('production.view')
  getDeptDashboard(@Param('departmentId') departmentId: string) {
    return this.svc.getDeptDashboard(+departmentId);
  }

  @Patch('tasks/:taskId/start')
  @RequirePermission('production.update')
  startWork(@Param('taskId') taskId: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.svc.startWork(+taskId, userId);
  }

  @Patch('tasks/:taskId/complete')
  @RequirePermission('production.update')
  completeWork(
    @Param('taskId') taskId: string,
    @Body() body: { remarks?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.svc.completeWork(+taskId, userId, body.remarks);
  }

  @Patch('tasks/:taskId/hold-work')
  @RequirePermission('production.update')
  holdWork(
    @Param('taskId') taskId: string,
    @Body() body: { remarks?: string },
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.svc.holdWork(+taskId, userId, body.remarks);
  }

  @Patch('tasks/:taskId/resume')
  @RequirePermission('production.update')
  resumeWork(@Param('taskId') taskId: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.svc.resumeWork(+taskId, userId);
  }
}

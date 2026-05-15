import {
  Controller, Get, Post, Patch, Body, Param, Query, Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ProductionExecutionService } from './production-execution.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('production/execution')
export class ProductionExecutionController {
  constructor(private readonly svc: ProductionExecutionService) {}

  // ── Jobs ──────────────────────────────────────────────────────────────────────

  @Get('jobs')
  @RequirePermission('production.view')
  findJobs(
    @Query('status')       status?:       string,
    @Query('priority')     priority?:     string,
    @Query('departmentId') departmentId?: string,
    @Query('orderId')      orderId?:      string,
  ) {
    return this.svc.findJobs({
      status,
      priority,
      departmentId: departmentId ? +departmentId : undefined,
      orderId:      orderId      ? +orderId      : undefined,
    });
  }

  @Get('jobs/:id')
  @RequirePermission('production.view')
  findJob(@Param('id') id: string) {
    return this.svc.findJobById(+id);
  }

  @Patch('jobs/:id/priority')
  @RequirePermission('production.update')
  updatePriority(@Param('id') id: string, @Body() body: { priority: string }) {
    return this.svc.updateJobPriority(+id, body.priority);
  }

  @Post('jobs/regenerate/:orderId')
  @RequirePermission('production.update')
  regenerate(@Param('orderId') orderId: string) {
    return this.svc.regenerateForOrder(+orderId);
  }

  // ── My stages (current user) ──────────────────────────────────────────────────

  @Get('my-stages')
  @RequirePermission('production.view')
  myStages(@Req() req: Request) {
    const userId = (req as any).user?.id;
    if (!userId) return [];
    return this.svc.findMyStages(userId);
  }

  // ── Department queue ──────────────────────────────────────────────────────────

  @Get('department/:departmentId/queue')
  @RequirePermission('production.view')
  departmentQueue(@Param('departmentId') departmentId: string) {
    return this.svc.findDepartmentQueue(+departmentId);
  }

  // ── Stage actions ─────────────────────────────────────────────────────────────

  @Patch('stages/:stageId/start')
  @RequirePermission('production.update')
  startStage(@Param('stageId') stageId: string, @Req() req: Request) {
    return this.svc.startStage(+stageId, (req as any).user?.id);
  }

  /** WORKING → STOPPED: record quantities, compute working time. */
  @Patch('stages/:stageId/stop')
  @RequirePermission('production.update')
  stopStage(
    @Param('stageId') stageId: string,
    @Body() body: {
      completedQty: number;
      rejectedQty?: number;
      remarks?: string;
      wastageRemarks?: string;
    },
    @Req() req: Request,
  ) {
    return this.svc.stopStage(
      +stageId,
      Number(body.completedQty),
      Number(body.rejectedQty ?? 0),
      body.remarks,
      (req as any).user?.id,
      body.wastageRemarks,
    );
  }

  /** STOPPED → COMPLETED: handover to next department (or close job). */
  @Patch('stages/:stageId/move-next')
  @RequirePermission('production.update')
  moveNext(@Param('stageId') stageId: string, @Req() req: Request) {
    return this.svc.moveNext(+stageId, (req as any).user?.id);
  }

  /** Legacy one-shot complete (WORKING → COMPLETED). Kept for backwards compat. */
  @Patch('stages/:stageId/complete')
  @RequirePermission('production.update')
  completeStage(
    @Param('stageId') stageId: string,
    @Body() body: {
      completedQty: number;
      rejectedQty?: number;
      remarks?: string;
      wastageRemarks?: string;
    },
    @Req() req: Request,
  ) {
    return this.svc.completeStage(
      +stageId,
      Number(body.completedQty),
      Number(body.rejectedQty ?? 0),
      body.remarks,
      (req as any).user?.id,
      body.wastageRemarks,
    );
  }

  /** WORKING → ON_HOLD. Accepts a reason for the hold. */
  @Patch('stages/:stageId/hold')
  @RequirePermission('production.update')
  holdStage(
    @Param('stageId') stageId: string,
    @Body() body: { reason?: string; remarks?: string },
  ) {
    return this.svc.holdStage(+stageId, body.reason, body.remarks);
  }

  @Patch('stages/:stageId/resume')
  @RequirePermission('production.update')
  resumeStage(@Param('stageId') stageId: string) {
    return this.svc.resumeStage(+stageId);
  }

  @Patch('stages/:stageId/cancel')
  @RequirePermission('production.update')
  cancelStage(@Param('stageId') stageId: string, @Body() body: { remarks?: string }) {
    return this.svc.cancelStage(+stageId, body.remarks);
  }

  @Patch('stages/:stageId/assign')
  @RequirePermission('production.assign')
  assignStage(@Param('stageId') stageId: string, @Body() body: { userId: number }) {
    return this.svc.assignStage(+stageId, body.userId);
  }
}

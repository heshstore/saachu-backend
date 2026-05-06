import { Controller, Get, Post, Param, Patch, Query, Body, ParseIntPipe, Req, ForbiddenException } from '@nestjs/common';
import { ProductionService } from './production.service';
import { ProductionStage, ProductionJobStatus, JobPriority } from './entities/production-job.entity';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ProductionPermission as PP } from './production-permission.enum';
import { AuditService } from '../logs/audit.service';

@Controller('production')
export class ProductionController {
  constructor(
    private readonly service: ProductionService,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  @RequirePermission(PP.VIEW)
  getDashboard() {
    return this.service.getDashboard();
  }

  @Get('summary')
  @RequirePermission(PP.VIEW)
  getSummary() {
    return this.service.getStageSummary();
  }

  @Get('stale-orders')
  @RequirePermission(PP.VIEW)
  getStaleOrders() {
    return this.service.getStaleApprovedOrders();
  }

  @Get('labour')
  @RequirePermission(PP.VIEW)
  getLabourSummary() {
    return this.service.getLabourSummary();
  }

  @Get('workforce')
  @RequirePermission(PP.VIEW)
  getWorkforceSummary() {
    return this.service.getWorkforceSummary();
  }

  @Get('analytics/top/:stage')
  @RequirePermission(PP.ANALYTICS)
  getTopPerformers(@Param('stage') stage: ProductionStage) {
    return this.service.getTopPerformers(stage);
  }

  @Get('analytics/stage/:stage')
  @RequirePermission(PP.ANALYTICS)
  getStagePerformance(@Param('stage') stage: ProductionStage) {
    return this.service.getStagePerformance(stage);
  }

  @Get('predict')
  @RequirePermission(PP.VIEW)
  getPrediction() {
    return this.service.getPredictionSummary();
  }

  @Get('predict/order/:orderId')
  @RequirePermission(PP.VIEW)
  getOrderPrediction(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.service.predictOrderRisk(orderId);
  }

  @Get('queue')
  @RequirePermission(PP.VIEW)
  getQueue(
    @Query('stage')       stage?: ProductionStage,
    @Query('status')      status?: ProductionJobStatus,
    @Query('assigned_to') assigned_to?: string,
    @Query('unassigned')  unassigned?: string,
  ) {
    return this.service.findQueue({
      stage,
      status,
      assigned_to: assigned_to ? Number(assigned_to) : undefined,
      unassigned:  unassigned === 'true',
    });
  }

  @Get('stage/:stage')
  @RequirePermission(PP.VIEW)
  findByStage(@Param('stage') stage: ProductionStage) {
    return this.service.findByStage(stage);
  }

  @Get('status/:status')
  @RequirePermission(PP.VIEW)
  findByStatus(@Param('status') status: ProductionJobStatus) {
    return this.service.findByStatus(status);
  }

  @Get('order/:orderId')
  @RequirePermission(PP.VIEW)
  findByOrder(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.service.findByOrder(orderId);
  }

  @Get('assigned/:userId')
  @RequirePermission(PP.VIEW)
  findByAssignee(@Param('userId', ParseIntPipe) userId: number) {
    return this.service.findByAssignee(userId);
  }

  @Patch(':id/assign/:userId')
  @RequirePermission(PP.ASSIGN)
  async assign(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Req() req: any,
  ) {
    const job = await this.service.assignJob(id, userId);
    this.audit.log({
      entity: 'production_job', entity_id: id,
      action: 'ASSIGN', user_id: req.user?.id,
      meta: { to: userId },
    });
    return job;
  }

  @Patch(':id/priority/:priority')
  @RequirePermission(PP.UPDATE_PRIORITY)
  async setPriority(
    @Param('id', ParseIntPipe) id: number,
    @Param('priority') priority: JobPriority,
    @Req() req: any,
  ) {
    const before = await this.service.getJobById(id);
    const job    = await this.service.setPriority(id, priority);
    this.audit.log({
      entity: 'production_job', entity_id: id,
      action: 'PRIORITY_UPDATE', user_id: req.user?.id,
      meta: { from: before?.priority, to: priority },
    });
    return job;
  }

  @Patch(':id/start')
  @RequirePermission(PP.UPDATE_STAGE)
  async startJob(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    await this.assertOwnerOrManager(id, req.user);
    const job = await this.service.startJob(id);
    this.audit.log({ entity: 'production_job', entity_id: id, action: 'STARTED', user_id: req.user?.id });
    return job;
  }

  @Patch(':id/stop')
  @RequirePermission(PP.UPDATE_STAGE)
  async stopJob(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    await this.assertOwnerOrManager(id, req.user);
    const job = await this.service.stopJob(id);
    this.audit.log({ entity: 'production_job', entity_id: id, action: 'STOPPED', user_id: req.user?.id });
    return job;
  }

  @Patch(':id/hold')
  @RequirePermission(PP.UPDATE_STAGE)
  async holdJob(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    await this.assertOwnerOrManager(id, req.user);
    const job = await this.service.holdJob(id);
    this.audit.log({ entity: 'production_job', entity_id: id, action: 'HELD', user_id: req.user?.id });
    return job;
  }

  @Post(':id/issue')
  @RequirePermission(PP.UPDATE_STAGE)
  async reportIssue(
    @Param('id', ParseIntPipe) id: number,
    @Body('note') note: string,
    @Req() req: any,
  ) {
    await this.service.reportIssue(id, note ?? '', req.user?.id);
    return { ok: true };
  }

  @Patch(':id/next-stage')
  @RequirePermission(PP.UPDATE_STAGE)
  async moveToNextStage(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ) {
    await this.assertOwnerOrManager(id, req.user);
    const before = await this.service.getJobById(id);
    const job    = await this.service.moveToNextStage(id);
    this.audit.log({
      entity: 'production_job', entity_id: id,
      action: 'STAGE_CHANGE', user_id: req.user?.id,
      meta: { from: before?.current_stage, to: job.current_stage },
    });
    return job;
  }

  @Patch(':id/stage/:stage')
  @RequirePermission(PP.UPDATE_STAGE)
  async moveToStage(
    @Param('id', ParseIntPipe) id: number,
    @Param('stage') stage: ProductionStage,
    @Req() req: any,
  ) {
    await this.assertOwnerOrManager(id, req.user);
    const before = await this.service.getJobById(id);
    const job    = await this.service.moveToStage(id, stage);
    this.audit.log({
      entity: 'production_job', entity_id: id,
      action: 'STAGE_CHANGE', user_id: req.user?.id,
      meta: { from: before?.current_stage, to: stage, override: true },
    });
    return job;
  }

  @Get('audit/:entityId')
  @RequirePermission(PP.VIEW)
  getAuditLog(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.audit.getByEntity('production_job', entityId);
  }

  private async assertOwnerOrManager(jobId: number, user: any): Promise<void> {
    if (!user) throw new ForbiddenException();
    if (user.role === 'Admin' || user.role === 'Production Manager') return;

    const job = await this.service.getJobById(jobId);
    if (!job || job.assigned_to !== user.id) {
      throw new ForbiddenException('You can only update jobs assigned to you');
    }
  }
}

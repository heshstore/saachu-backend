import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
} from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { DepartmentControlService } from './department-control.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('departments')
export class DepartmentsController {
  constructor(
    private readonly svc: DepartmentsService,
    private readonly ctrl: DepartmentControlService,
  ) {}

  // ── Existing routes (unchanged) ───────────────────────────────────────────────

  @Get()
  @RequirePermission('production.view')
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.svc.findAll(includeInactive === 'true');
  }

  @Post()
  @RequirePermission('production.update')
  create(@Body() data: any) {
    return this.svc.create(data);
  }

  @Patch(':id')
  @RequirePermission('production.update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.svc.update(+id, data);
  }

  // ── Control Center: full detail ───────────────────────────────────────────────

  @Get(':id/detail')
  @RequirePermission('production.view')
  getDetail(@Param('id') id: string) {
    return this.ctrl.getDetail(+id);
  }

  @Get(':id/readiness')
  @RequirePermission('production.view')
  getReadiness(@Param('id') id: string) {
    return this.ctrl.getReadiness(+id);
  }

  @Get(':id/dashboard')
  @RequirePermission('production.view')
  getDashboard(@Param('id') id: string) {
    return this.ctrl.getDashboard(+id);
  }

  // ── Extension (Basic Info + Capacity + Ownership + Quality + Rules) ───────────

  @Patch(':id/extension')
  @RequirePermission('production.update')
  updateExtension(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.updateExtension(+id, data);
  }

  // ── Checklist management ──────────────────────────────────────────────────────

  @Get(':id/checklist')
  @RequirePermission('production.view')
  getChecklist(@Param('id') id: string) {
    return this.ctrl.getChecklist(+id);
  }

  @Post(':id/checklist/items')
  @RequirePermission('production.update')
  addChecklistItem(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.addChecklistItem(+id, data);
  }

  @Patch(':id/checklist/items/reorder')
  @RequirePermission('production.update')
  reorderItems(@Param('id') id: string, @Body() body: { orderedIds: number[] }) {
    return this.ctrl.reorderChecklistItems(+id, body.orderedIds);
  }

  @Patch(':id/checklist/items/:iid')
  @RequirePermission('production.update')
  updateChecklistItem(@Param('iid') iid: string, @Body() data: any) {
    return this.ctrl.updateChecklistItem(+iid, data);
  }

  @Delete(':id/checklist/items/:iid')
  @RequirePermission('production.update')
  deleteChecklistItem(@Param('iid') iid: string) {
    return this.ctrl.deleteChecklistItem(+iid);
  }

  // ── Daily session (Production Lock) ──────────────────────────────────────────

  @Get(':id/checklist/today')
  @RequirePermission('production.view')
  getTodaySession(@Param('id') id: string) {
    return this.ctrl.getTodaySession(+id);
  }

  @Post(':id/checklist/today/start')
  @RequirePermission('production.view')
  startSession(@Param('id') id: string, @Request() req: any) {
    return this.ctrl.startSession(+id, req.user.id);
  }

  @Post(':id/checklist/today/complete/:itemId')
  @RequirePermission('production.view')
  completeItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { sessionId: number; notes?: string },
    @Request() req: any,
  ) {
    return this.ctrl.completeItem(body.sessionId, +itemId, req.user.id, body.notes);
  }

  @Delete(':id/checklist/today/complete/:itemId')
  @RequirePermission('production.view')
  uncompleteItem(
    @Param('itemId') itemId: string,
    @Body() body: { sessionId: number },
  ) {
    return this.ctrl.uncompleteItem(body.sessionId, +itemId);
  }

  @Post(':id/checklist/today/approve')
  @RequirePermission('production.update')
  approveSession(@Body() body: { sessionId: number }, @Request() req: any) {
    return this.ctrl.approveSession(body.sessionId, req.user.id);
  }

  // Phase 1: operator explicitly completes inspection → machines become READY
  @Post(':id/checklist/today/finish')
  @RequirePermission('production.view')
  completeInspection(@Param('id') id: string, @Request() req: any) {
    return this.ctrl.completeInspection(+id, req.user.id);
  }

  // ── Machines ──────────────────────────────────────────────────────────────────

  @Get(':id/machines')
  @RequirePermission('production.view')
  getMachines(@Param('id') id: string) {
    return this.ctrl.getMachines(+id);
  }

  @Post(':id/machines')
  @RequirePermission('production.update')
  addMachine(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.addMachine(+id, data);
  }

  @Patch(':id/machines/:mid')
  @RequirePermission('production.update')
  updateMachine(@Param('mid') mid: string, @Body() data: any) {
    return this.ctrl.updateMachine(+mid, data);
  }

  @Delete(':id/machines/:mid')
  @RequirePermission('production.update')
  deleteMachine(@Param('mid') mid: string) {
    return this.ctrl.deleteMachine(+mid);
  }

  // ── Maintenance ───────────────────────────────────────────────────────────────

  @Get(':id/maintenance')
  @RequirePermission('production.view')
  getMaintenance(@Param('id') id: string) {
    return this.ctrl.getMaintenance(+id);
  }

  @Post(':id/maintenance')
  @RequirePermission('production.update')
  addMaintenance(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.addMaintenance(+id, data);
  }

  @Patch(':id/maintenance/:sid')
  @RequirePermission('production.update')
  updateMaintenance(@Param('sid') sid: string, @Body() data: any) {
    return this.ctrl.updateMaintenance(+sid, data);
  }

  @Post(':id/maintenance/:sid/complete')
  @RequirePermission('production.view')
  completeMaintenance(@Param('sid') sid: string, @Request() req: any) {
    return this.ctrl.completeMaintenance(+sid, req.user.id);
  }

  @Delete(':id/maintenance/:sid')
  @RequirePermission('production.update')
  deleteMaintenance(@Param('sid') sid: string) {
    return this.ctrl.deleteMaintenance(+sid);
  }

  // ── Skills ────────────────────────────────────────────────────────────────────

  @Get(':id/skills')
  @RequirePermission('production.view')
  getSkills(@Param('id') id: string) {
    return this.ctrl.getSkills(+id);
  }

  @Post(':id/skills')
  @RequirePermission('production.update')
  addSkill(@Param('id') id: string, @Body() body: { skillName: string }) {
    return this.ctrl.addSkill(+id, body.skillName);
  }

  @Delete(':id/skills/:sid')
  @RequirePermission('production.update')
  deleteSkill(@Param('sid') sid: string) {
    return this.ctrl.deleteSkill(+sid);
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────────

  @Get(':id/kpis')
  @RequirePermission('production.view')
  getKpis(@Param('id') id: string) {
    return this.ctrl.getKpis(+id);
  }

  @Post(':id/kpis')
  @RequirePermission('production.update')
  addKpi(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.addKpi(+id, data);
  }

  @Patch(':id/kpis/:kid')
  @RequirePermission('production.update')
  updateKpi(@Param('kid') kid: string, @Body() data: any) {
    return this.ctrl.updateKpi(+kid, data);
  }

  @Delete(':id/kpis/:kid')
  @RequirePermission('production.update')
  deleteKpi(@Param('kid') kid: string) {
    return this.ctrl.deleteKpi(+kid);
  }

  // ── KRAs ──────────────────────────────────────────────────────────────────────

  @Get(':id/kras')
  @RequirePermission('production.view')
  getKras(@Param('id') id: string) {
    return this.ctrl.getKras(+id);
  }

  @Post(':id/kras')
  @RequirePermission('production.update')
  addKra(@Param('id') id: string, @Body() data: any) {
    return this.ctrl.addKra(+id, data);
  }

  @Delete(':id/kras/:kid')
  @RequirePermission('production.update')
  deleteKra(@Param('kid') kid: string) {
    return this.ctrl.deleteKra(+kid);
  }

  // ── Documents ─────────────────────────────────────────────────────────────────

  @Get(':id/documents')
  @RequirePermission('production.view')
  getDocuments(@Param('id') id: string) {
    return this.ctrl.getDocuments(+id);
  }

  @Post(':id/documents')
  @RequirePermission('production.update')
  addDocument(@Param('id') id: string, @Body() data: any, @Request() req: any) {
    return this.ctrl.addDocument(+id, data, req.user.id);
  }

  @Delete(':id/documents/:did')
  @RequirePermission('production.update')
  deleteDocument(@Param('did') did: string) {
    return this.ctrl.deleteDocument(+did);
  }
}

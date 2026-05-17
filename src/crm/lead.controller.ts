import {
  Controller, Get, Post, Put, Patch, Delete, ForbiddenException,
  Param, Body, Query, Request, ParseIntPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LeadService } from './lead.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { CreateManualLeadDto } from './dto/create-manual-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { NoteType } from './entities/lead-note.entity';
import { RequirePermission } from '../auth/require-permission.decorator';
import { LeadStage, OutcomeType } from './entities/lead.entity';

@Controller('crm/leads')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Get()
  @RequirePermission('lead.view')
  findAll(@Query() filters: any, @Request() req) {
    return this.leadService.findAll(filters, req.user);
  }

  /**
   * Manual lead creation from the frontend.
   * Uses strict DTO — name, phone, city, country, product_interest are required.
   * Throttled to 10 creates/min per IP to prevent double-submit duplicates.
   */
  @Post()
  @RequirePermission('lead.create')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create(@Body() dto: CreateManualLeadDto, @Request() req) {
    return this.leadService.create(dto as unknown as CreateLeadDto, req.user);
  }

  @Get('queue')
  @RequirePermission('lead.view')
  getQueue(@Request() req) {
    return this.leadService.getQueue(req.user);
  }

  @Get(':id/decision')
  @RequirePermission('lead.view')
  getDecision(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.getDecision(id, req.user);
  }

  @Post(':id/log-action')
  @RequirePermission('lead.edit')
  logAction(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note: string; noteType?: NoteType; newStatus?: string; outcomeType?: OutcomeType; objectionType?: string; callbackDate?: string },
    @Request() req,
  ) {
    return this.leadService.logAction(id, body, req.user, req.ip);
  }

  @Get(':id/audit')
  @RequirePermission('lead.view')
  getAuditLog(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.getAuditLog(id, req.user);
  }

  @Get(':id/customer-match')
  @RequirePermission('lead.view')
  getCustomerMatch(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.getCustomerMatch(id, req.user);
  }

  @Get(':id')
  @RequirePermission('lead.view')
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.findOne(id, req.user, req.ip);
  }

  @Put(':id')
  @RequirePermission('lead.edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLeadDto,
    @Request() req,
  ) {
    return this.leadService.update(id, dto, req.user, req.ip);
  }

  @Delete(':id')
  @RequirePermission('lead.delete')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.softDelete(id, req.user);
  }

  @Patch(':id/assign')
  @RequirePermission('lead.assign')
  assign(
    @Param('id', ParseIntPipe) id: number,
    @Body('userId') rawUserId: number | null,
    @Request() req,
  ) {
    const userId = rawUserId === null || rawUserId === undefined ? null : Number(rawUserId);
    return this.leadService.assignLead(id, userId, req.user, req.ip);
  }

  @Post(':id/notes')
  @RequirePermission('lead.edit')
  addNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note: string; type?: NoteType },
    @Request() req,
  ) {
    return this.leadService.addNote(id, body, req.user);
  }

  @Get(':id/notes')
  @RequirePermission('lead.view')
  getNotes(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.getNotes(id, req.user);
  }

  @Post(':id/followups')
  @RequirePermission('lead.edit')
  addFollowUp(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { due_date: string; note?: string },
    @Request() req,
  ) {
    return this.leadService.addFollowUp(id, body, req.user, req.ip);
  }

  @Patch(':id/followups/:fid/complete')
  @RequirePermission('lead.edit')
  completeFollowUp(
    @Param('fid', ParseIntPipe) fid: number,
    @Request() req,
  ) {
    return this.leadService.completeFollowUp(fid, req.user, req.ip);
  }

  /**
   * Check-convert: returns whether a customer record already exists for this lead,
   * plus prefill data for the ConvertToCustomerModal. Does NOT create anything.
   * The frontend uses this to decide whether to open the modal or navigate directly to quotation.
   */
  @Post(':id/convert')
  @RequirePermission('lead.convert')
  convertLead(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.checkConvert(id, req.user);
  }

  /**
   * Quick-convert: one-click flow that finds or creates a customer record,
   * marks the lead CONVERTED, and returns the customerId. Used by automated
   * flows and integrations — not called directly by the main frontend modal.
   */
  @Post(':id/quick-convert')
  @RequirePermission('lead.convert')
  quickConvert(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.quickConvert(id, req.user, req.ip);
  }

  @Patch(':id/stage')
  @RequirePermission('lead.edit')
  updateStage(
    @Param('id', ParseIntPipe) id: number,
    @Body('stage') stage: LeadStage,
    @Request() req,
  ) {
    return this.leadService.updateStage(id, stage, req.user);
  }

  @Post(':id/create-quotation')
  @RequirePermission('lead.edit')
  createQuotation(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.createQuotationFromLead(id, req.user, req.ip);
  }

  @Patch(':id/mark-converted')
  @RequirePermission('lead.convert')
  markConverted(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { customerId: number; quotationId: number },
    @Request() req,
  ) {
    return this.leadService.markConverted(id, body.customerId, body.quotationId, req.user, req.ip);
  }

  // ── Lead lock ─────────────────────────────────────────────────────────────────

  @Post(':id/lock')
  @RequirePermission('lead.view')
  acquireLock(@Param('id', ParseIntPipe) id: number, @Request() req) {
    this.leadService.acquireLock(id, req.user);
    return { locked: true, leadId: id, userId: req.user.id, userName: req.user.name };
  }

  @Delete(':id/lock')
  @RequirePermission('lead.view')
  releaseLock(@Param('id', ParseIntPipe) id: number, @Request() req) {
    const released = this.leadService.releaseLock(id, req.user);
    if (!released) {
      throw new ForbiddenException('You do not hold the lock on this lead');
    }
    return { released: true, leadId: id };
  }

  // ── Per-lead automation pause ─────────────────────────────────────────────────

  @Patch(':id/automation')
  @RequirePermission('lead.edit')
  setAutomationPaused(
    @Param('id', ParseIntPipe) id: number,
    @Body('paused') paused: boolean,
    @Body('reason') reason: string,
    @Request() req,
  ) {
    return this.leadService.setAutomationPaused(id, paused, reason, req.user, req.ip);
  }

  @Post(':id/automation/snooze')
  @RequirePermission('lead.edit')
  snoozeAutomation(
    @Param('id', ParseIntPipe) id: number,
    @Body('durationMins') durationMins: number,
    @Body('reason') reason: string,
    @Request() req,
  ) {
    return this.leadService.snoozeAutomation(id, durationMins, reason, req.user, req.ip);
  }

  // ── Automation settings (Admin only) ─────────────────────────────────────────

  @Get('automation/settings')
  @RequirePermission('lead.view')
  getAutomationSettings() {
    return this.leadService.getAutomationSettings();
  }

  @Put('automation/settings')
  @RequirePermission('lead.view')
  updateAutomationSettings(@Body() body: Record<string, boolean>, @Request() req) {
    if (req.user?.role !== 'Admin' && req.user?.role !== 'COO') {
      throw new ForbiddenException('Only Admin or COO can change automation settings');
    }
    return this.leadService.updateAutomationSettings(body);
  }
}

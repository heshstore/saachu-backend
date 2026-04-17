import {
  Controller, Get, Post, Put, Patch, Delete,
  Param, Body, Query, Request, ParseIntPipe,
} from '@nestjs/common';
import { LeadService } from './lead.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { NoteType } from './entities/lead-note.entity';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('crm/leads')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Get()
  @RequirePermission('lead.view')
  findAll(@Query() filters: any, @Request() req) {
    return this.leadService.findAll(filters, req.user);
  }

  @Post()
  @RequirePermission('lead.create')
  create(@Body() dto: CreateLeadDto, @Request() req) {
    return this.leadService.create(dto, req.user);
  }

  @Get(':id')
  @RequirePermission('lead.view')
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.leadService.findOne(id, req.user);
  }

  @Put(':id')
  @RequirePermission('lead.edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLeadDto,
    @Request() req,
  ) {
    return this.leadService.update(id, dto, req.user);
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
    @Body('userId', ParseIntPipe) userId: number,
    @Request() req,
  ) {
    return this.leadService.assignLead(id, userId, req.user);
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
  getNotes(@Param('id', ParseIntPipe) id: number) {
    return this.leadService.getNotes(id);
  }

  @Post(':id/followups')
  @RequirePermission('lead.edit')
  addFollowUp(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { due_date: string; note?: string },
    @Request() req,
  ) {
    return this.leadService.addFollowUp(id, body, req.user);
  }

  @Patch(':id/followups/:fid/complete')
  @RequirePermission('lead.edit')
  completeFollowUp(
    @Param('fid', ParseIntPipe) fid: number,
    @Request() req,
  ) {
    return this.leadService.completeFollowUp(fid, req.user);
  }

  @Post(':id/convert')
  @RequirePermission('lead.convert')
  checkConvert(@Param('id', ParseIntPipe) id: number) {
    return this.leadService.checkConvert(id);
  }

  @Patch(':id/mark-converted')
  @RequirePermission('lead.convert')
  markConverted(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { customerId: number; quotationId: number },
    @Request() req,
  ) {
    return this.leadService.markConverted(id, body.customerId, body.quotationId, req.user);
  }
}

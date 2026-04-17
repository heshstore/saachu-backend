import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Lead, LeadSource, LeadStatus } from './entities/lead.entity';
import { LeadNote, NoteType } from './entities/lead-note.entity';
import { LeadFollowUp } from './entities/lead-followup.entity';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadAssignmentService } from './lead-assignment.service';

function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.slice(-10);
}

function toSentenceCase(s: string): string {
  if (!s) return s;
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function sentenceCaseWords(s: string): string {
  if (!s) return s;
  return s.trim().toLowerCase().replace(/(^\w|\.\s+\w)/g, (c) => c.toUpperCase());
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(
    @InjectRepository(Lead)
    private leadRepo: Repository<Lead>,
    @InjectRepository(LeadNote)
    private noteRepo: Repository<LeadNote>,
    @InjectRepository(LeadFollowUp)
    private followUpRepo: Repository<LeadFollowUp>,
    private assignmentService: LeadAssignmentService,
  ) {}

  async create(dto: CreateLeadDto, user: any): Promise<{ lead: Lead; warning?: string }> {
    const phone = normalizePhone(dto.phone);
    if (phone.length !== 10) {
      throw new BadRequestException('Phone number must be 10 digits. Please check and try again.');
    }

    // Idempotency: check external_id if provided
    if (dto.external_id) {
      const existing = await this.findByExternalId(dto.external_id);
      if (existing) return { lead: existing };
    }

    // Auto-assign if not specified
    let assignedTo = dto.assigned_to;
    if (!assignedTo) {
      assignedTo = await this.assignmentService.getNextAssignee(dto.source) ?? undefined;
    }

    // Duplicate phone detection
    const dupCount = await this.leadRepo.count({
      where: { phone, is_active: true },
    });

    const lead = this.leadRepo.create({
      ...dto,
      name: sentenceCaseWords(dto.name),
      phone,
      notes: dto.notes ? toSentenceCase(dto.notes) : undefined,
      product_interest: dto.product_interest ? sentenceCaseWords(dto.product_interest) : undefined,
      assigned_to: assignedTo,
      created_by: user?.id,
      duplicate_flag: dupCount > 0,
    });

    const saved = await this.leadRepo.save(lead);
    this.logger.log(`Lead created id=${saved.id} phone=${phone} source=${dto.source} assigned_to=${assignedTo ?? 'none'}${dupCount > 0 ? ' [DUPLICATE]' : ''}`);

    // Auto-schedule first follow-up 3 days from now for inbound leads
    if (dto.source !== LeadSource.MANUAL) {
      await this.scheduleFirstFollowUp(saved);
    }

    return {
      lead: saved,
      warning: dupCount > 0 ? 'duplicate_phone' : undefined,
    };
  }

  async findAll(filters: any, user: any): Promise<Lead[]> {
    const q = this.leadRepo.createQueryBuilder('l');
    q.where('l.is_active = true');

    // RBAC data isolation
    const fullAccessRoles = ['Admin', 'COO', 'Sales Manager'];
    if (!fullAccessRoles.includes(user?.role)) {
      q.andWhere('l.assigned_to = :uid OR l.created_by = :uid', { uid: user.id });
    }

    if (filters.status) q.andWhere('l.status = :status', { status: filters.status });
    if (filters.source) q.andWhere('l.source = :source', { source: filters.source });
    if (filters.assigned_to) q.andWhere('l.assigned_to = :at', { at: filters.assigned_to });
    if (filters.search) {
      q.andWhere('(l.name ILIKE :s OR l.phone ILIKE :s OR l.email ILIKE :s)', {
        s: `%${filters.search}%`,
      });
    }
    if (filters.from) q.andWhere('l.created_at >= :from', { from: filters.from });
    if (filters.to) q.andWhere('l.created_at <= :to', { to: filters.to });

    q.orderBy('l.created_at', 'DESC');
    return q.getMany();
  }

  async findOne(
    id: number,
    user: any,
  ): Promise<Omit<Lead, 'notes'> & { notes: LeadNote[]; followups: LeadFollowUp[] }> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    this.assertAccess(lead, user);

    const notes = await this.noteRepo.find({
      where: { lead_id: id },
      order: { created_at: 'DESC' },
    });
    const followups = await this.followUpRepo.find({
      where: { lead_id: id },
      order: { due_date: 'ASC' },
    });

    return { ...lead, notes, followups };
  }

  async update(id: number, dto: UpdateLeadDto, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    if (dto.phone) dto.phone = normalizePhone(dto.phone);
    if (dto.name) dto.name = sentenceCaseWords(dto.name);
    if ((dto as any).notes) (dto as any).notes = toSentenceCase((dto as any).notes);
    if (dto.product_interest) dto.product_interest = sentenceCaseWords(dto.product_interest);

    Object.assign(lead, dto);
    return this.leadRepo.save(lead);
  }

  async softDelete(id: number, user: any): Promise<void> {
    const lead = await this.leadRepo.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);
    lead.is_active = false;
    await this.leadRepo.save(lead);
  }

  async assignLead(id: number, userId: number, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    lead.assigned_to = userId;
    return this.leadRepo.save(lead);
  }

  async addNote(leadId: number, body: { note: string; type?: NoteType }, user: any): Promise<LeadNote> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.assertAccess(lead, user);

    const note = this.noteRepo.create({
      lead_id: leadId,
      note: toSentenceCase(body.note),
      type: body.type ?? NoteType.GENERAL,
      created_by: user.id,
    });
    return this.noteRepo.save(note);
  }

  async getNotes(leadId: number): Promise<LeadNote[]> {
    return this.noteRepo.find({ where: { lead_id: leadId }, order: { created_at: 'DESC' } });
  }

  async addFollowUp(leadId: number, body: { due_date: string; note?: string }, user: any): Promise<LeadFollowUp> {
    const lead = await this.leadRepo.findOne({ where: { id: leadId, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    const fu = this.followUpRepo.create({
      lead_id: leadId,
      due_date: new Date(body.due_date),
      note: body.note ? toSentenceCase(body.note) : undefined,
      created_by: user.id,
    });
    // Update lead follow_up_date to the new one
    lead.follow_up_date = fu.due_date;
    await this.leadRepo.save(lead);
    return this.followUpRepo.save(fu);
  }

  async completeFollowUp(followUpId: number, user: any): Promise<LeadFollowUp> {
    const fu = await this.followUpRepo.findOne({ where: { id: followUpId } });
    if (!fu) throw new NotFoundException('Follow-up not found');
    fu.is_completed = true;
    fu.completed_at = new Date();
    fu.completed_by = user.id;
    return this.followUpRepo.save(fu);
  }

  async getDueFollowUps(): Promise<LeadFollowUp[]> {
    const window = new Date(Date.now() + 30 * 60 * 1000);
    return this.followUpRepo
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.lead', 'l')
      .where('f.is_completed = false')
      .andWhere('f.due_date <= :window', { window })
      .andWhere('l.is_active = true')
      .getMany();
  }

  async checkConvert(id: number): Promise<any> {
    const lead = await this.leadRepo.findOne({ where: { id, is_active: true } });
    if (!lead) throw new NotFoundException('Lead not found');

    // Check if customer exists by phone
    const existing = await this.leadRepo.manager.query(
      `SELECT id, "companyName", "contactName", mobile1, email, city
       FROM customer WHERE mobile1 = $1 LIMIT 1`,
      [lead.phone],
    );

    const customerExists = existing.length > 0;
    return {
      customerExists,
      customerId: customerExists ? existing[0].id : null,
      prefillData: {
        contactName: lead.name,
        mobile1: lead.phone,
        email: lead.email ?? '',
        companyName: lead.name,
        product_interest: lead.product_interest ?? '',
      },
    };
  }

  async markConverted(id: number, customerId: number, quotationId: number, user: any): Promise<Lead> {
    const lead = await this.leadRepo.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    lead.status = LeadStatus.CONVERTED;
    lead.customer_id = customerId;
    lead.quotation_id = quotationId;
    return this.leadRepo.save(lead);
  }

  async findByExternalId(externalId: string): Promise<Lead | null> {
    return this.leadRepo.findOne({ where: { external_id: externalId } });
  }

  // Called by WhatsApp service via EventEmitter
  @OnEvent('lead.incoming')
  async handleIncomingLead(payload: {
    phone: string;
    name: string;
    source: LeadSource;
    whatsapp_chat_id?: string;
    raw_payload?: any;
    external_id?: string;
  }): Promise<void> {
    try {
      await this.create(
        {
          phone: payload.phone,
          name: payload.name,
          source: payload.source,
          whatsapp_chat_id: payload.whatsapp_chat_id,
          raw_payload: payload.raw_payload,
          external_id: payload.external_id,
        } as CreateLeadDto,
        { id: null, role: 'Admin' },
      );
    } catch (e) {
      this.logger.error(`handleIncomingLead failed for phone=${payload.phone}: ${e?.message}`, e?.stack);
    }
  }

  private assertAccess(lead: Lead, user: any) {
    const fullAccess = ['Admin', 'COO', 'Sales Manager'];
    if (fullAccess.includes(user?.role)) return;
    if (lead.assigned_to !== user?.id && lead.created_by !== user?.id) {
      throw new NotFoundException('Lead not found');
    }
  }

  private async scheduleFirstFollowUp(lead: Lead): Promise<void> {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    const fu = this.followUpRepo.create({
      lead_id: lead.id,
      due_date: due,
      note: 'Initial follow-up',
      created_by: lead.created_by ?? lead.assigned_to ?? 1,
    });
    await this.followUpRepo.save(fu);
    lead.follow_up_date = due;
    await this.leadRepo.save(lead);
  }
}

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PromotionContact } from './entities/promotion-contact.entity';
import { PromotionCaptureDto } from './dto/promotion-capture.dto';
import { LogsService, LogAction } from '../logs/logs.service';
import { LeadService } from '../crm/lead.service';
import { LeadSource } from '../crm/entities/lead.entity';
import { LeadContext, contextToLabel } from '../crm/enums/lead-context.enum';
import { normalizePhoneForIdentity } from '../crm/normalizers/lead-normalizer';

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    @InjectRepository(PromotionContact)
    private readonly repo: Repository<PromotionContact>,
    private readonly dataSource: DataSource,
    private readonly logsService: LogsService,
    private readonly leadService: LeadService,
  ) {}

  private async ensureTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS promotion_contacts (
        id               SERIAL PRIMARY KEY,
        whatsapp_number  VARCHAR(15),
        email            VARCHAR(255),
        source           TEXT,
        page_url         TEXT,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_promo_whatsapp ON promotion_contacts(whatsapp_number)`,
    );
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS idx_promo_email ON promotion_contacts(email)`,
    );
  }

  /**
   * Normalise an arbitrary phone string to E.164 (+91XXXXXXXXXX) for comparison
   * against the leads table. Returns empty string if input is unusable.
   */
  private normalizePhone(raw: string): string {
    return normalizePhoneForIdentity(raw) ?? '';
  }

  /**
   * Returns true if any active lead in the CRM already owns this phone number.
   */
  private async phoneExistsInLeads(rawPhone: string): Promise<boolean> {
    const normalized = this.normalizePhone(rawPhone);
    if (!normalized) return false;

    const bare10 = normalized.replace(/\D/g, '').slice(-10);

    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM leads
       WHERE (phone = $1 OR phone = $2)
         AND is_active = true
       LIMIT 1`,
      [normalized, bare10],
    );
    return rows.length > 0;
  }

  /**
   * Routes name+phone promotion captures through LeadService.create()
   * (identity gate, quality scoring, assignment, dedup).
   */
  private async saveAsLead(
    name: string,
    phone: string,
    email: string | undefined,
    source: string | undefined,
    pageUrl: string | undefined,
  ): Promise<number> {
    const normalized = this.normalizePhone(phone);
    const result = await this.leadService.create(
      {
        name,
        phone: normalized || undefined,
        email: email || undefined,
        source: LeadSource.SHOPIFY,
        lead_source_label: source ?? 'SHOPIFY – Promotion Form',
        landing_page: pageUrl ?? '',
        context: contextToLabel(LeadContext.SHOPIFY_PRODUCT_FORM),
      },
      { id: null, role: 'Admin' },
    );

    if (result.analyticsOnly || !result.lead) {
      this.logger.warn(
        `[LEAD_BLOCKED] source=promotion_capture reason=${result.reason ?? 'no_identity'}`,
      );
      return 0;
    }

    return result.lead.id;
  }

  async create(dto: PromotionCaptureDto): Promise<{
    success: boolean;
    message: string;
    routed_to: 'lead' | 'promotion' | 'skipped';
    id?: number;
  }> {
    await this.ensureTable();

    const name    = (dto.name            || '').trim() || undefined;
    const phone   = (dto.whatsapp_number || '').trim() || undefined;
    const email   = (dto.email           || '').trim() || undefined;

    if (!phone && !email) {
      throw new BadRequestException('At least one of whatsapp_number or email is required.');
    }

    // ── Rule 1: name + phone → save as CRM lead, not promotion ───────────────
    if (name && phone) {
      const leadId = await this.saveAsLead(name, phone, email, dto.source, dto.page_url);
      if (!leadId) {
        return { success: true, message: 'Tracked as analytics (no CRM identity)', routed_to: 'skipped' };
      }
      this.logger.log(`Promotion routed to lead id=${leadId} (name+phone present)`);
      this.logsService.log(LogAction.LEAD_CREATED, { leadId, phone, routed_from: 'promotion', name });
      return { success: true, message: 'Saved as lead', routed_to: 'lead', id: leadId };
    }

    // ── Rule 2: phone present but phone already in CRM leads → skip ───────────
    if (phone) {
      const inLeads = await this.phoneExistsInLeads(phone);
      if (inLeads) {
        this.logger.log(`Promotion skipped — phone already in leads (phone=${phone})`);
        this.logsService.log(LogAction.PROMOTION_SKIPPED, { phone, reason: 'phone_in_leads' });
        return { success: true, message: 'Already a lead', routed_to: 'skipped' };
      }
    }

    // ── Rule 3: email-only or new phone-only → save to promotion_contacts ─────
    if (phone) {
      const existing = await this.repo.findOne({ where: { whatsapp_number: phone } });
      if (existing) {
        return { success: true, message: 'Already exists', routed_to: 'promotion', id: existing.id };
      }
    }

    if (email) {
      const existing = await this.repo.findOne({ where: { email } });
      if (existing) {
        return { success: true, message: 'Already exists', routed_to: 'promotion', id: existing.id };
      }
    }

    const record = this.repo.create({
      whatsapp_number: phone ?? null,
      email:           email ?? null,
      source:          dto.source  || 'SHOPIFY',
      page_url:        dto.page_url || null,
      tag:             dto.tag     || 'promotion_capture',
    });

    const saved = await this.repo.save(record);
    this.logger.log(`Promotion contact saved id=${saved.id}`);
    this.logsService.log(LogAction.PROMOTION_CAPTURED, { id: saved.id, phone: phone ?? null, email: email ?? null, tag: saved.tag });
    return { success: true, message: 'Saved', routed_to: 'promotion', id: saved.id };
  }

  async findAll(): Promise<PromotionContact[]> {
    return this.repo.find({ order: { created_at: 'DESC' }, take: 500 });
  }
}

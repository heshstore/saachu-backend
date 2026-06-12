import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ImportSkippedContact } from './import-skipped-contact.entity';
import type { SkipEntry } from '../audience/audience.service';
import { AudienceService, normalizeAudiencePhone } from '../audience/audience.service';
import { assertPromotionalWriteAllowed } from '../../../config/database-environment';

export const RECOVERABLE_CODES = new Set(['missing_contact_info', 'invalid_phone']);
export const NON_RECOVERABLE_CODES = new Set(['junk_rejected', 'crm_protected', 'crm_linked']);

@Injectable()
export class SkipRecoveryService {
  private readonly logger = new Logger(SkipRecoveryService.name);

  constructor(
    @InjectRepository(ImportSkippedContact)
    private readonly repo: Repository<ImportSkippedContact>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly audienceService: AudienceService,
  ) {}

  /**
   * Persist skip entries from a bulk import batch.
   * Called fire-and-forget from AudienceController after bulkUpsert returns.
   * rawRows is the original input array — row_number is 1-based index into it.
   */
  async persistSkips(
    entries: SkipEntry[],
    rawRows: Record<string, any>[],
    batchId: string,
  ): Promise<void> {
    if (!entries.length) return;
    const records = entries.map((e) => {
      const raw = rawRows[e.row_number - 1] ?? {};
      return this.repo.create({
        reason_code:     e.reason_code,
        reason:          e.reason,
        row_number:      e.row_number,
        phone:           e.phone ?? raw.phone ?? null,
        email:           raw.email ?? null,
        company:         raw.company ?? null,
        name:            e.name ?? raw.name ?? raw.customer_name ?? null,
        city:            raw.city ?? null,
        business_type:   raw.business_type ?? null,
        import_batch_id: batchId,
        raw_row:         raw,
        recovered:       false,
      });
    });
    await this.repo.save(records);
    this.logger.log(`[SkipRecovery] persisted ${records.length} skip records (batch=${batchId})`);
  }

  async search(params: {
    q?: string;
    reason_code?: string;
    recovered?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: ImportSkippedContact[]; total: number; page: number; limit: number; pages: number }> {
    const page  = Math.max(1, params.page ?? 1);
    const limit = Math.min(250, Math.max(1, params.limit ?? 50));
    const offset = (page - 1) * limit;

    const qb = this.repo.createQueryBuilder('s').orderBy('s.imported_at', 'DESC');

    if (params.q) {
      qb.andWhere(
        '(s.phone ILIKE :q OR s.email ILIKE :q OR s.company ILIKE :q OR s.name ILIKE :q)',
        { q: `%${params.q}%` },
      );
    }
    if (params.reason_code) {
      qb.andWhere('s.reason_code = :rc', { rc: params.reason_code });
    }
    if (params.recovered === 'true') {
      qb.andWhere('s.recovered = true');
    } else if (params.recovered === 'false') {
      qb.andWhere('s.recovered = false');
    }

    qb.skip(offset).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit, pages: Math.ceil(total / limit) || 1 };
  }

  async summary(): Promise<{
    total: number;
    recoverable: number;
    non_recoverable: number;
    invalid_phone: number;
    missing_contact_info: number;
    crm_protected: number;
    crm_linked: number;
    junk_rejected: number;
    already_recovered: number;
    pending_recoverable: number;
  }> {
    const rows: any[] = await this.ds.query(`
      SELECT
        COUNT(*)::int                                                                         AS total,
        COUNT(*) FILTER (WHERE reason_code IN ('missing_contact_info','invalid_phone'))::int AS recoverable,
        COUNT(*) FILTER (WHERE reason_code IN ('junk_rejected','crm_protected','crm_linked'))::int AS non_recoverable,
        COUNT(*) FILTER (WHERE reason_code = 'invalid_phone')::int                          AS invalid_phone,
        COUNT(*) FILTER (WHERE reason_code = 'missing_contact_info')::int                   AS missing_contact_info,
        COUNT(*) FILTER (WHERE reason_code = 'crm_protected')::int                          AS crm_protected,
        COUNT(*) FILTER (WHERE reason_code = 'crm_linked')::int                             AS crm_linked,
        COUNT(*) FILTER (WHERE reason_code = 'junk_rejected')::int                          AS junk_rejected,
        COUNT(*) FILTER (WHERE recovered = true)::int                                        AS already_recovered,
        COUNT(*) FILTER (WHERE recovered = false
          AND reason_code IN ('missing_contact_info','invalid_phone'))::int                  AS pending_recoverable
      FROM import_skipped_contacts
    `);
    const r = rows[0] ?? {};
    return {
      total:                r.total                ?? 0,
      recoverable:          r.recoverable          ?? 0,
      non_recoverable:      r.non_recoverable      ?? 0,
      invalid_phone:        r.invalid_phone        ?? 0,
      missing_contact_info: r.missing_contact_info ?? 0,
      crm_protected:        r.crm_protected        ?? 0,
      crm_linked:           r.crm_linked           ?? 0,
      junk_rejected:        r.junk_rejected        ?? 0,
      already_recovered:    r.already_recovered    ?? 0,
      pending_recoverable:  r.pending_recoverable  ?? 0,
    };
  }

  async exportCsv(filter?: { reason_code?: string; recoverable_only?: boolean }): Promise<string> {
    const qb = this.repo.createQueryBuilder('s').orderBy('s.imported_at', 'DESC');
    if (filter?.reason_code) qb.andWhere('s.reason_code = :rc', { rc: filter.reason_code });
    if (filter?.recoverable_only) {
      qb.andWhere("s.reason_code IN ('missing_contact_info','invalid_phone')");
    }
    const rows = await qb.getMany();

    const header = 'Row Number,Phone,Email,Company,Name,City,Business Type,Skip Reason,Reason Detail,Import Date,Recovered';
    const escape = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.row_number ?? '',
      r.phone ?? '',
      r.email ?? '',
      escape(r.company),
      escape(r.name),
      escape(r.city),
      escape(r.business_type),
      r.reason_code,
      escape(r.reason),
      r.imported_at ? new Date(r.imported_at).toISOString() : '',
      r.recovered ? 'Yes' : 'No',
    ].join(','));
    return [header, ...lines].join('\n');
  }

  async recover(
    id: string,
    editedData: {
      phone?: string;
      email?: string;
      company?: string;
      name?: string;
      city?: string;
      business_type?: string;
      confirm_production?: boolean;
    },
  ): Promise<{ contact_id: string; phone: string | null }> {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new NotFoundException(`Skip record ${id} not found`);
    if (record.recovered) {
      throw new Error('Contact has already been recovered');
    }
    if (NON_RECOVERABLE_CODES.has(record.reason_code)) {
      throw new Error(`Reason code '${record.reason_code}' is non-recoverable`);
    }

    const phone = editedData.phone ? normalizeAudiencePhone(editedData.phone) : null;
    const email = (editedData.email ?? record.email ?? '').trim() || null;
    if (!phone && !email) {
      throw new Error('Recovery requires a valid phone or email');
    }

    assertPromotionalWriteAllowed(editedData.confirm_production === true);

    const contact = await this.audienceService.create(
      {
        phone:         phone ?? undefined,
        email:         email ?? undefined,
        company:       editedData.company  ?? record.company  ?? undefined,
        name:          editedData.name     ?? record.name     ?? undefined,
        customer_name: editedData.name     ?? record.name     ?? undefined,
        city:          editedData.city     ?? record.city     ?? undefined,
        business_type: editedData.business_type ?? record.business_type ?? undefined,
        source:        'Skip Recovery',
      },
      { confirmProduction: editedData.confirm_production === true },
    );

    await this.repo.update(id, { recovered: true, recovered_at: new Date() });
    this.logger.log(`[SkipRecovery] recovered skip=${id} → audience=${contact.id} phone=${phone}`);
    return { contact_id: contact.id, phone };
  }

  async findOne(id: string): Promise<ImportSkippedContact> {
    const r = await this.repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException(`Skip record ${id} not found`);
    return r;
  }
}

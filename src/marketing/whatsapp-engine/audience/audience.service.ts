import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, DeepPartial, EntityManager, In } from 'typeorm';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { ReplyStatus } from '../entities/enums';
import { AudienceAiService } from '../ai/audience-ai.service';
import {
  buildNewContactRow,
  collapseBatchByPhone,
  ImportRow,
  mergeIntoExisting,
  normalizeEmail,
} from './contact-merge.util';
import { GeoResolverService } from './geo-resolver.service';
import { assertPromotionalWriteAllowed } from '../../../config/database-environment';
import {
  classifyGeoQuality,
  GeoCorrection,
  isGarbageCity,
  isValidEmailFormat,
} from './geo-quality.util';

/** Canonical E.164 for marketing_audience.phone — matches production storage (+91XXXXXXXXXX). */
export function normalizeAudiencePhone(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const d = trimmed.replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  if (d.length === 13 && d.startsWith('091')) return `+${d.slice(1)}`;
  if (d.length >= 10 && d.length <= 15) return `+${d}`;
  return null;
}

export const MAX_IMPORT_ROWS_PER_REQUEST = 5000;

export type SkipReasonCode =
  | 'missing_contact_info'
  | 'invalid_phone'
  | 'junk_rejected'
  | 'crm_protected'
  | 'crm_linked';

export type SkipEntry = {
  row_number: number;
  name: string | null;
  phone: string | null;
  reason_code: SkipReasonCode;
  reason: string;
};

export type BulkUpsertResult = {
  total: number;
  created: number;
  updated: number;
  duplicates_found: number;
  duplicates_removed: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  new_contacts: number;
  updated_contacts: number;
  merged_contacts: number;
  duplicate_phones_removed: number;
  duplicate_emails_detected: number;
  skipped_contacts: number;
  errors: { phone: string; reason: string }[];
  email_duplicate_warnings: {
    phone: string;
    email: string;
    conflicting_phone: string;
    conflicting_id: string;
  }[];
  geo_valid: number;
  geo_partial: number;
  junk_rejected: number;
  geo_corrections: GeoCorrection[];
  skip_reasons: SkipEntry[];
  skip_reason_breakdown: Record<SkipReasonCode, number>;
};

@Injectable()
export class AudienceService {
  constructor(
    @InjectRepository(MarketingAudience)
    private repo: Repository<MarketingAudience>,
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly audienceAi: AudienceAiService,
    private readonly geoResolver: GeoResolverService,
  ) {}

  findAll(): Promise<MarketingAudience[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async search(params: {
    q?: string;
    city?: string;
    business_type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: MarketingAudience[]; total: number; page: number; limit: number; pages: number }> {
    const page   = Math.max(1, params.page  ?? 1);
    const limit  = Math.min(250, Math.max(1, params.limit ?? 50));
    const offset = (page - 1) * limit;
    const q      = (params.q ?? '').trim();

    const qb = this.repo.createQueryBuilder('a');

    if (q) {
      qb.andWhere(
        '(a.phone ILIKE :q OR a.email ILIKE :q OR a.company ILIKE :q OR a.name ILIKE :q OR a.customer_name ILIKE :q OR a.city ILIKE :q OR a.business_type ILIKE :q)',
        { q: `%${q}%` },
      );
    }
    if (params.city) {
      qb.andWhere('a.city ILIKE :city', { city: `%${params.city}%` });
    }
    if (params.business_type) {
      qb.andWhere('a.business_type ILIKE :bt', { bt: `%${params.business_type}%` });
    }

    switch (params.status) {
      case 'opted_out':       qb.andWhere('a.opt_out = true'); break;
      case 'active':          qb.andWhere('a.opt_out = false').andWhere('a.customer_id IS NULL'); break;
      case 'customer_linked': qb.andWhere('a.customer_id IS NOT NULL'); break;
      case 'cooldown':        qb.andWhere('a.cooldown_until IS NOT NULL').andWhere('a.cooldown_until > NOW()'); break;
      case 'not_on_whatsapp': qb.andWhere("a.wa_registration_status = 'NOT_REGISTERED'"); break;
      case 'lead':            qb.andWhere("a.reply_status = 'LEAD_CREATED'"); break;
      case 'replied':         qb.andWhere("a.reply_status = 'REPLIED'"); break;
    }

    qb.orderBy(
      "COALESCE(NULLIF(LOWER(a.company), ''), NULLIF(LOWER(a.name), ''), NULLIF(LOWER(a.customer_name), ''))",
      'ASC',
      'NULLS LAST',
    );

    const [data, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getFilterOptions(): Promise<{ cities: string[]; business_types: string[] }> {
    const [cities, business_types] = await Promise.all([
      this.ds.query<{ city: string }[]>(
        `SELECT DISTINCT city FROM marketing_audience WHERE city IS NOT NULL AND TRIM(city) != '' ORDER BY city LIMIT 200`,
      ).catch(() => []),
      this.ds.query<{ business_type: string }[]>(
        `SELECT DISTINCT business_type FROM marketing_audience WHERE business_type IS NOT NULL AND TRIM(business_type) != '' ORDER BY business_type LIMIT 200`,
      ).catch(() => []),
    ]);
    return {
      cities:         cities.map(r => r.city),
      business_types: business_types.map(r => r.business_type),
    };
  }

  async findOne(id: string): Promise<MarketingAudience> {
    const a = await this.repo.findOne({ where: { id } });
    if (!a) throw new NotFoundException(`Audience member ${id} not found`);
    return a;
  }

  create(
    dto: Partial<MarketingAudience>,
    opts?: { confirmProduction?: boolean },
  ): Promise<MarketingAudience> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);
    return this.repo.save(this.repo.create(dto));
  }

  async update(
    id: string,
    dto: Partial<MarketingAudience>,
    opts?: { confirmProduction?: boolean },
  ): Promise<MarketingAudience> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);
    await this.findOne(id);
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string, opts?: { confirmProduction?: boolean }): Promise<void> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);
    await this.findOne(id);
    await this.repo.delete(id);
  }

  async checkConflicts(phones: string[]): Promise<{
    phone: string;
    id: string;
    name: string | null;
    city: string | null;
    business_type: string | null;
    customer_id: number | null;
  }[]> {
    if (!phones.length) return [];
    const normalized = [...new Set(
      phones.map(p => normalizeAudiencePhone(p)).filter((p): p is string => !!p),
    )];
    if (!normalized.length) return [];
    const rows: any[] = await this.ds.query(
      `SELECT id, phone, name, city, business_type, customer_id
       FROM marketing_audience
       WHERE phone = ANY($1)`,
      [normalized],
    );
    return rows;
  }

  /**
   * Master Contact Merge Engine — promotional DB import pipeline.
   * 1. Normalize phones
   * 2. Merge duplicate phones within batch (enrich, do not drop)
   * 3. Compare against DB — enrich existing or insert new
   * 4. Resolve city → derive state/country (city is master)
   * 5. Assign geo_quality — reject JUNK
   * 6. Detect cross-phone email duplicates (POSSIBLE_DUPLICATE — no auto-merge)
   */
  async bulkUpsert(
    rows: Partial<MarketingAudience>[],
    opts?: { confirmProduction?: boolean },
  ): Promise<BulkUpsertResult> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);

    const empty = this._emptyResult();
    if (!rows.length) return empty;
    if (rows.length > MAX_IMPORT_ROWS_PER_REQUEST) {
      throw new BadRequestException(
        `Import batch exceeds ${MAX_IMPORT_ROWS_PER_REQUEST} contacts per request`,
      );
    }

    const errors: BulkUpsertResult['errors'] = [];
    const emailWarnings: BulkUpsertResult['email_duplicate_warnings'] = [];
    const skipReasons: SkipEntry[] = [];
    let rowsSkipped = 0;
    let duplicateEmailsDetected = 0;
    let inFileMerged = 0;
    let geoValid = 0;
    let geoPartial = 0;
    let junkRejected = 0;
    const geoCorrections: GeoCorrection[] = [];

    const valid: ImportRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 1;
      const hasPhone = !!r.phone?.trim();
      const hasEmail = !!r.email?.trim();
      if (!hasPhone && !hasEmail) {
        errors.push({ phone: String(r.phone ?? r.email ?? ''), reason: 'Requires phone or email' });
        skipReasons.push({ row_number: rowNumber, name: r.name ?? null, phone: r.phone ?? null, reason_code: 'missing_contact_info', reason: 'No phone or email provided' });
        rowsSkipped++;
        continue;
      }
      valid.push({ ...r, source: r.source ?? 'CSV Import', _rowIndex: rowNumber });
    }

    if (!valid.length) {
      return { ...empty, total: rows.length, rows_skipped: rowsSkipped, skipped_contacts: rowsSkipped, errors,
        skip_reasons: skipReasons, skip_reason_breakdown: _breakdown(skipReasons) };
    }

    // Step 1–3: normalize + merge within batch
    const phoneCandidates: ImportRow[] = [];
    for (const r of valid.filter(row => !!row.phone?.trim())) {
      const canonical = normalizeAudiencePhone(r.phone!);
      if (!canonical) {
        errors.push({ phone: r.phone!, reason: 'Invalid phone number' });
        skipReasons.push({ row_number: r._rowIndex ?? 0, name: r.name ?? null, phone: r.phone ?? null, reason_code: 'invalid_phone', reason: 'Phone could not be normalized to E.164' });
        rowsSkipped++;
        continue;
      }
      phoneCandidates.push({ ...r, phone: canonical });
    }

    const { merged: collapsedRows, duplicatesMerged } = collapseBatchByPhone(
      phoneCandidates,
      normalizeAudiencePhone,
    );
    inFileMerged = duplicatesMerged;

    const geoResolved = await this.geoResolver.resolveBatch(collapsedRows);
    const enrichedRows: ImportRow[] = [];

    for (let i = 0; i < collapsedRows.length; i++) {
      const row = collapsedRows[i];
      const phone = row.phone!;
      const geo = geoResolved.get(i)!;
      const emailValid = isValidEmailFormat(row.email);

      const enriched: ImportRow = {
        ...row,
        city: geo.city ?? row.city ?? null,
        state: geo.resolved ? geo.state : null,
        country: geo.resolved ? geo.country : null,
        _geoResolved: geo.resolved,
        _geoSource: geo.source,
        _geoCorrections: geo.corrections,
      };

      enriched._geoQuality = classifyGeoQuality({
        phone,
        email: row.email ?? null,
        name: row.name ?? null,
        customer_name: row.customer_name ?? null,
        city: enriched.city ?? null,
        state: enriched.state ?? null,
        country: enriched.country ?? null,
        phoneValid: true,
        emailValid,
        cityResolved: geo.resolved,
      });

      if (enriched._geoQuality === 'JUNK') {
        const junkDetail = isGarbageCity(row.city)
          ? 'Garbage city value'
          : 'No usable contact data';
        errors.push({ phone, reason: `JUNK rejected: ${junkDetail}` });
        skipReasons.push({ row_number: row._rowIndex ?? 0, name: row.name ?? null, phone, reason_code: 'junk_rejected', reason: `JUNK: ${junkDetail}` });
        junkRejected++;
        rowsSkipped++;
        continue;
      }

      if (geo.corrections.length) geoCorrections.push(...geo.corrections);
      if (enriched._geoQuality === 'VALID') geoValid++;
      else geoPartial++;

      enrichedRows.push(enriched);
    }

    const emailOnly = valid.filter(r => !r.phone?.trim());

    let newContacts = 0;
    let updatedContacts = 0;
    let enrichedMerges = 0;

    if (!enrichedRows.length && !emailOnly.length) {
      return this._buildResult(rows.length, newContacts, updatedContacts, inFileMerged, enrichedMerges,
        duplicateEmailsDetected, rowsSkipped, errors, emailWarnings, geoValid, geoPartial, junkRejected, geoCorrections, skipReasons);
    }

    const phones = enrichedRows.map(r => r.phone!);
    const customerPhoneSet = phones.length ? await this._customerPhoneSet(phones) : new Set<string>();

    const existingRows = phones.length
      ? await this.repo.find({ where: { phone: In(phones) } })
      : [];
    const existingMap = new Map(existingRows.map(e => [e.phone!, e]));

    const emailsToCheck: string[] = [];
    for (const incoming of enrichedRows) {
      const existing = existingMap.get(incoming.phone!);
      emailsToCheck.push(incoming.email ?? '', existing?.email ?? '');
    }
    const emailDupMap = await this._bulkEmailDuplicateMap(emailsToCheck);

    const toInsert: Partial<MarketingAudience>[] = [];
    const toUpdate: { id: string; patch: Partial<MarketingAudience> }[] = [];

    for (const incoming of enrichedRows) {
      const phone = incoming.phone!;

      const existing = existingMap.get(phone);

      if (customerPhoneSet.has(phone) && !existing?.customer_id) {
        errors.push({ phone, reason: 'Phone exists in Customer DB — cannot import without customer link' });
        skipReasons.push({ row_number: incoming._rowIndex ?? 0, name: incoming.name ?? null, phone, reason_code: 'crm_protected', reason: 'Phone exists in Customer DB' });
        rowsSkipped++;
        continue;
      }

      if (existing?.customer_id != null) {
        errors.push({ phone, reason: 'Linked to customer — cannot overwrite' });
        skipReasons.push({ row_number: incoming._rowIndex ?? 0, name: incoming.name ?? null, phone, reason_code: 'crm_linked', reason: 'Contact is linked to a Customer record' });
        rowsSkipped++;
        continue;
      }

      if (existing) {
        const patch = mergeIntoExisting(existing, incoming);
        const emailDup = this._resolveEmailDuplicate(
          emailDupMap,
          patch.email ?? existing.email,
          phone,
        );
        if (emailDup) {
          patch.duplicate_status = 'POSSIBLE_DUPLICATE';
          patch.duplicate_email_phone = emailDup.phone;
          patch.merge_suggestion = {
            type: 'EMAIL_DUPLICATE',
            email: normalizeEmail(patch.email ?? existing.email),
            conflicting_phone: emailDup.phone,
            conflicting_id: emailDup.id,
            action: 'human_review_required',
          };
          duplicateEmailsDetected++;
          emailWarnings.push({
            phone,
            email: normalizeEmail(patch.email ?? existing.email)!,
            conflicting_phone: emailDup.phone,
            conflicting_id: emailDup.id,
          });
        }
        patch.quality_score = this._profileScore({ ...existing, ...patch });
        toUpdate.push({ id: existing.id, patch });
        enrichedMerges++;
        updatedContacts++;
      } else {
        const score = this._profileScore(incoming as MarketingAudience);
        const row = buildNewContactRow(incoming, score);
        const emailDup = this._resolveEmailDuplicate(emailDupMap, row.email, phone);
        if (emailDup) {
          row.duplicate_status = 'POSSIBLE_DUPLICATE';
          row.duplicate_email_phone = emailDup.phone;
          row.merge_suggestion = {
            type: 'EMAIL_DUPLICATE',
            email: row.email,
            conflicting_phone: emailDup.phone,
            conflicting_id: emailDup.id,
            action: 'human_review_required',
          };
          duplicateEmailsDetected++;
          emailWarnings.push({
            phone,
            email: row.email!,
            conflicting_phone: emailDup.phone,
            conflicting_id: emailDup.id,
          });
        }
        toInsert.push(row);
        newContacts++;
      }
    }

    const queryRunner = this.ds.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      if (emailOnly.length) {
        await queryRunner.manager.save(
          MarketingAudience,
          emailOnly.map(r => queryRunner.manager.create(MarketingAudience, r as DeepPartial<MarketingAudience>)),
        );
        newContacts += emailOnly.length;
      }

      if (toInsert.length) {
        await queryRunner.manager
          .createQueryBuilder()
          .insert()
          .into(MarketingAudience)
          .values(toInsert as any)
          .execute();
      }

      await this._bulkSaveUpdates(queryRunner.manager, toUpdate);
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    return this._buildResult(
      rows.length, newContacts, updatedContacts, inFileMerged, enrichedMerges,
      duplicateEmailsDetected, rowsSkipped, errors, emailWarnings,
      geoValid, geoPartial, junkRejected, geoCorrections, skipReasons,
    );
  }

  private _emptyResult(): BulkUpsertResult {
    return {
      total: 0, created: 0, updated: 0,
      duplicates_found: 0, duplicates_removed: 0,
      rows_inserted: 0, rows_updated: 0, rows_skipped: 0,
      new_contacts: 0, updated_contacts: 0, merged_contacts: 0,
      duplicate_phones_removed: 0, duplicate_emails_detected: 0, skipped_contacts: 0,
      errors: [], email_duplicate_warnings: [],
      geo_valid: 0, geo_partial: 0, junk_rejected: 0, geo_corrections: [],
      skip_reasons: [], skip_reason_breakdown: _emptyBreakdown(),
    };
  }

  private _buildResult(
    total: number,
    newContacts: number,
    updatedContacts: number,
    inFileMerged: number,
    enrichedMerges: number,
    duplicateEmailsDetected: number,
    rowsSkipped: number,
    errors: BulkUpsertResult['errors'],
    emailWarnings: BulkUpsertResult['email_duplicate_warnings'],
    geoValid = 0,
    geoPartial = 0,
    junkRejected = 0,
    geoCorrections: GeoCorrection[] = [],
    skipReasons: SkipEntry[] = [],
  ): BulkUpsertResult {
    const mergedContacts = inFileMerged + enrichedMerges;
    return {
      total,
      created: newContacts,
      updated: updatedContacts,
      duplicates_found: inFileMerged,
      duplicates_removed: inFileMerged,
      rows_inserted: newContacts,
      rows_updated: updatedContacts,
      rows_skipped: rowsSkipped,
      new_contacts: newContacts,
      updated_contacts: updatedContacts,
      merged_contacts: mergedContacts,
      duplicate_phones_removed: inFileMerged,
      duplicate_emails_detected: duplicateEmailsDetected,
      skipped_contacts: rowsSkipped,
      errors,
      email_duplicate_warnings: emailWarnings,
      geo_valid: geoValid,
      geo_partial: geoPartial,
      junk_rejected: junkRejected,
      geo_corrections: geoCorrections,
      skip_reasons: skipReasons,
      skip_reason_breakdown: _breakdown(skipReasons),
    };
  }

  private _profileScore(row: Partial<MarketingAudience>): number {
    return this.audienceAi._computeScore({
      name: row.name ?? null,
      city: row.city ?? null,
      business_type: row.business_type ?? null,
      customer_id: row.customer_id ?? null,
      reply_status: row.reply_status ?? ReplyStatus.NONE,
      last_contacted_at: null,
      quality_score: 0,
      fatigue_score: 0,
    } as MarketingAudience);
  }

  /** Read-only — canonical promo phones that match Customer DB mobiles (last-10-digit). */
  private async _customerPhoneSet(phones: string[]): Promise<Set<string>> {
    const last10ToCanon = new Map<string, string>();
    for (const p of phones) {
      const l10 = p.replace(/\D/g, '').slice(-10);
      if (l10.length === 10) last10ToCanon.set(l10, p);
    }
    const last10 = [...last10ToCanon.keys()];
    if (!last10.length) return new Set();

    const fromCustomer: { m: string }[] = await this.ds.query(
      `SELECT mobile1 AS m FROM customer
       WHERE RIGHT(REGEXP_REPLACE(mobile1, '[^0-9]', '', 'g'), 10) = ANY($1)
       UNION
       SELECT mobile2 AS m FROM customer
       WHERE mobile2 IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(mobile2, '[^0-9]', '', 'g'), 10) = ANY($1)`,
      [last10],
    ).catch(() => []);

    const blocked = new Set<string>();
    for (const r of fromCustomer) {
      const canon = normalizeAudiencePhone(r.m);
      if (canon) blocked.add(canon);
      const l10 = (r.m || '').replace(/\D/g, '').slice(-10);
      const fromBatch = last10ToCanon.get(l10);
      if (fromBatch) blocked.add(fromBatch);
    }
    return blocked;
  }

  /** One query per batch — map normalized email → first conflicting contact. */
  private async _bulkEmailDuplicateMap(
    rawEmails: string[],
  ): Promise<Map<string, { id: string; phone: string }>> {
    const norms = [...new Set(
      rawEmails.map(e => normalizeEmail(e)).filter((e): e is string => !!e),
    )];
    if (!norms.length) return new Map();

    const rows: { id: string; phone: string; norm_email: string }[] = await this.ds.query(
      `SELECT id, phone, LOWER(TRIM(email)) AS norm_email
       FROM marketing_audience
       WHERE LOWER(TRIM(email)) = ANY($1)
         AND phone IS NOT NULL`,
      [norms],
    );

    const map = new Map<string, { id: string; phone: string }>();
    for (const row of rows) {
      if (!map.has(row.norm_email)) {
        map.set(row.norm_email, { id: row.id, phone: row.phone });
      }
    }
    return map;
  }

  private _resolveEmailDuplicate(
    emailMap: Map<string, { id: string; phone: string }>,
    email: string | null | undefined,
    phone: string,
  ): { id: string; phone: string } | null {
    const norm = normalizeEmail(email);
    if (!norm) return null;
    const hit = emailMap.get(norm);
    if (!hit || hit.phone === phone) return null;
    return hit;
  }

  /** Chunked save — one round-trip per chunk instead of per-row update. */
  private async _bulkSaveUpdates(
    manager: EntityManager,
    toUpdate: { id: string; patch: Partial<MarketingAudience> }[],
  ): Promise<void> {
    if (!toUpdate.length) return;
    const CHUNK = 100;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      await manager.save(
        MarketingAudience,
        chunk.map(({ id, patch }) => ({ id, ...patch })),
      );
    }
  }

  async getContactHistory(id: string): Promise<{
    contact: { created_at: Date; opt_out: boolean; reply_status: string; last_contacted_at: Date | null; last_reply_at: Date | null };
    logs: {
      campaign_id: string | null;
      campaign_name: string | null;
      status: string;
      sent_at: string | null;
      delivered_at: string | null;
      read_at: string | null;
      reply_received: boolean;
      reply_message: string | null;
    }[];
  }> {
    const contact = await this.findOne(id);
    const logs = await this.ds.query<any[]>(
      `SELECT
         l.campaign_id, c.campaign_name,
         l.status, l.sent_at, l.delivered_at, l.read_at,
         l.reply_received, l.reply_message
       FROM whatsapp_message_logs l
       LEFT JOIN marketing_campaigns c ON c.id = l.campaign_id
       WHERE l.customer_phone = $1
       ORDER BY l.sent_at DESC
       LIMIT 100`,
      [contact.phone],
    ).catch(() => []);
    return {
      contact: {
        created_at:       contact.created_at,
        opt_out:          contact.opt_out,
        reply_status:     contact.reply_status,
        last_contacted_at: contact.last_contacted_at ?? null,
        last_reply_at:    contact.last_reply_at ?? null,
      },
      logs,
    };
  }

  async markOptOut(id: string, opts?: { confirmProduction?: boolean }): Promise<MarketingAudience> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);
    await this.repo.update(id, { opt_out: true, reply_status: ReplyStatus.OPTED_OUT });
    return this.findOne(id);
  }

  findEligible(minScore = 0, testOnly = false): Promise<MarketingAudience[]> {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.opt_out = false')
      .andWhere('a.is_whatsapp_valid = true')
      .andWhere('(a.wa_registration_status IS NULL OR a.wa_registration_status != :notReg)', { notReg: 'NOT_REGISTERED' });

    if (testOnly) {
      qb.andWhere('a.is_test_contact = true');
    } else {
      qb
        .andWhere('a.quality_score >= :minScore', { minScore })
        .andWhere('(a.cooldown_until IS NULL OR a.cooldown_until <= :now)', { now: new Date() })
        .andWhere('a.is_test_contact IS NOT TRUE');
    }

    return qb.orderBy('a.quality_score', 'DESC').getMany();
  }

  findTestContacts(): Promise<MarketingAudience[]> {
    return this.repo.find({ where: { is_test_contact: true }, order: { created_at: 'DESC' } });
  }

  getTestPhones(): Promise<string[]> {
    return this.repo
      .createQueryBuilder('a')
      .select('a.phone', 'phone')
      .where('a.is_test_contact = true')
      .andWhere('a.opt_out = false')
      .getRawMany<{ phone: string }>()
      .then((rows) => rows.map((r) => r.phone));
  }

  async markAsTestContact(
    id: string,
    isTest: boolean,
    opts?: { confirmProduction?: boolean },
  ): Promise<MarketingAudience> {
    assertPromotionalWriteAllowed(opts?.confirmProduction === true);
    await this.repo.update(id, { is_test_contact: isTest });
    return this.findOne(id);
  }

  async getHealthStats(): Promise<{
    total: number;
    opted_out: number;
    in_cooldown: number;
    eligible: number;
    score_distribution: { bucket: string; count: number }[];
    strength_distribution: { strength: string; count: number }[];
    possible_email_duplicates: number;
  }> {
    type StatRow = {
      total: string;
      opted_out: string;
      in_cooldown: string;
      eligible: string;
      s0_20: string;
      s21_40: string;
      s41_60: string;
      s61_80: string;
      s81_100: string;
      low: string;
      medium: string;
      high: string;
      email_dupes: string;
    };

    const rows: StatRow[] = await this.ds.query(`
      SELECT
        COUNT(*)                                                                   AS total,
        COUNT(*) FILTER (WHERE opt_out = true)                                     AS opted_out,
        COUNT(*) FILTER (WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()) AS in_cooldown,
        COUNT(*) FILTER (
          WHERE opt_out = false
            AND is_whatsapp_valid = true
            AND (cooldown_until IS NULL OR cooldown_until <= NOW())
        )                                                                          AS eligible,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 0  AND 20)                    AS s0_20,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 21 AND 40)                    AS s21_40,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 41 AND 60)                    AS s41_60,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 61 AND 80)                    AS s61_80,
        COUNT(*) FILTER (WHERE quality_score BETWEEN 81 AND 100)                   AS s81_100,
        COUNT(*) FILTER (WHERE contact_strength = 'LOW')                           AS low,
        COUNT(*) FILTER (WHERE contact_strength = 'MEDIUM')                        AS medium,
        COUNT(*) FILTER (WHERE contact_strength = 'HIGH')                          AS high,
        COUNT(*) FILTER (WHERE duplicate_status = 'POSSIBLE_DUPLICATE')            AS email_dupes
      FROM marketing_audience
    `);

    const r = rows[0];
    return {
      total: parseInt(r.total, 10),
      opted_out: parseInt(r.opted_out, 10),
      in_cooldown: parseInt(r.in_cooldown, 10),
      eligible: parseInt(r.eligible, 10),
      score_distribution: [
        { bucket: '0–20',   count: parseInt(r.s0_20,   10) },
        { bucket: '21–40',  count: parseInt(r.s21_40,  10) },
        { bucket: '41–60',  count: parseInt(r.s41_60,  10) },
        { bucket: '61–80',  count: parseInt(r.s61_80,  10) },
        { bucket: '81–100', count: parseInt(r.s81_100, 10) },
      ],
      strength_distribution: [
        { strength: 'LOW',    count: parseInt(r.low,    10) },
        { strength: 'MEDIUM', count: parseInt(r.medium, 10) },
        { strength: 'HIGH',   count: parseInt(r.high,   10) },
      ],
      possible_email_duplicates: parseInt(r.email_dupes, 10),
    };
  }
}

function _emptyBreakdown(): Record<SkipReasonCode, number> {
  return { missing_contact_info: 0, invalid_phone: 0, junk_rejected: 0, crm_protected: 0, crm_linked: 0 };
}

function _breakdown(entries: SkipEntry[]): Record<SkipReasonCode, number> {
  const b = _emptyBreakdown();
  for (const e of entries) b[e.reason_code] = (b[e.reason_code] ?? 0) + 1;
  return b;
}

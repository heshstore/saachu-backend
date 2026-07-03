import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { WhatsappMessageQueue } from '../entities/whatsapp-message-queue.entity';
import { MarketingCampaign } from '../entities/marketing-campaign.entity';
import { QueueStatus, WhatsAppNumberStatus } from '../entities/enums';
import { AudienceService } from '../audience/audience.service';
import { NumbersService } from '../numbers/numbers.service';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';
import { ShopifyCatalogItem } from '../../../shopify-catalog/entities/shopify-catalog-item.entity';
import { getMatureDailyCapacity } from '../shared/number-limits';
import { getIstDayBounds } from '../shared/ist-time';
import { NumberConnectionState } from '../shared/number-state';
import { normalizeSkipReason, SkipReason } from '../shared/skip-reason';

const STORE_URL = 'https://www.heshstore.in';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectRepository(WhatsappMessageQueue)
    private repo: Repository<WhatsappMessageQueue>,
    @InjectRepository(ShopifyCatalogItem)
    private catalogRepo: Repository<ShopifyCatalogItem>,
    private readonly audienceService: AudienceService,
    private readonly numbersService: NumbersService,
    private readonly whatsAppService: MarketingWhatsAppService,
  ) {}

  async findPending(limit = 5): Promise<WhatsappMessageQueue[]> {
    const now = new Date();
    const results = await this.repo.find({
      where: {
        status: QueueStatus.PENDING,
        scheduled_at: LessThanOrEqual(now),
      },
      order: { priority: 'DESC', scheduled_at: 'ASC' },
      take: limit,
    });

    const [totalPending, futurePending, minRow, statusDist] = await Promise.all(
      [
        this.repo.count({ where: { status: QueueStatus.PENDING } }),
        this.repo
          .createQueryBuilder('q')
          .where('q.status = :s', { s: QueueStatus.PENDING })
          .andWhere('q.scheduled_at > :now', { now })
          .getCount(),
        this.repo
          .createQueryBuilder('q')
          .select('MIN(q.scheduled_at)', 'min')
          .where('q.status = :s', { s: QueueStatus.PENDING })
          .getRawOne<{ min: string | null }>(),
        this.repo
          .createQueryBuilder('q')
          .select('q.status', 'status')
          .addSelect('COUNT(*)', 'cnt')
          .groupBy('q.status')
          .getRawMany<{ status: string; cnt: string }>(),
      ],
    );

    this.logger.log(
      `[MKT_FIND_PENDING_DIAG] server_time=${now.toISOString()} ` +
        `matched=${results.length} total_pending_rows=${totalPending} ` +
        `excluded_future_scheduled_at=${futurePending} ` +
        `min_pending_scheduled_at=${minRow?.min ?? 'null'}`,
    );
    this.logger.log(
      `[MKT_QUEUE_STATUS_DIST] dist=${JSON.stringify(statusDist.map((r) => ({ status: r.status, count: parseInt(r.cnt, 10) })))}`,
    );

    return results;
  }

  // Returns pending items whose campaign has test_mode=true — bypasses window gate in sender tick.
  findTestModePending(limit = 5): Promise<WhatsappMessageQueue[]> {
    return this.repo
      .createQueryBuilder('q')
      .innerJoin('marketing_campaigns', 'mc', 'mc.id = q.campaign_id')
      .where('q.status = :status', { status: QueueStatus.PENDING })
      .andWhere('q.scheduled_at <= :now', { now: new Date() })
      .andWhere('mc.test_mode = :testMode', { testMode: true })
      .orderBy('q.priority', 'DESC')
      .addOrderBy('q.scheduled_at', 'ASC')
      .take(limit)
      .getMany();
  }

  findNextPendingForNumber(
    numberId: string,
    testModeOnly = false,
  ): Promise<WhatsappMessageQueue | null> {
    const qb = this.repo
      .createQueryBuilder('q')
      .where('q.status = :status', { status: QueueStatus.PENDING })
      .andWhere('q.scheduled_at <= :now', { now: new Date() })
      .andWhere('q.number_id = :numberId', { numberId })
      .orderBy('q.priority', 'DESC')
      .addOrderBy('q.scheduled_at', 'ASC')
      .limit(1);

    if (testModeOnly) {
      qb.innerJoin(
        'marketing_campaigns',
        'mc',
        'mc.id = q.campaign_id',
      ).andWhere('mc.test_mode = :testMode', { testMode: true });
    }

    return qb.getOne();
  }

  async findActivePhonesSet(): Promise<Set<string>> {
    const { start: todayStart } = getIstDayBounds();
    // Include ALL statuses scoped to today — prevents re-queuing phones that
    // were SENT, SKIPPED, or FAILED earlier today (not just PENDING/PROCESSING).
    const rows = await this.repo
      .createQueryBuilder('q')
      .select('q.customer_phone', 'phone')
      .where('q.created_at >= :todayStart', { todayStart })
      .getRawMany<{ phone: string }>();
    return new Set(rows.map((r) => r.phone));
  }

  // Returns a map of campaignId → number of queue rows created today for that campaign.
  // Used by _buildQueue() to enforce per-campaign daily_target caps idempotently.
  async countTodayByCampaign(
    campaignIds: string[],
  ): Promise<Map<string, number>> {
    if (!campaignIds.length) return new Map();
    const { start: todayStart } = getIstDayBounds();
    const rows = await this.repo
      .createQueryBuilder('q')
      .select('q.campaign_id', 'campaignId')
      .addSelect('COUNT(*)', 'count')
      .where('q.campaign_id IN (:...ids)', { ids: campaignIds })
      .andWhere('q.created_at >= :todayStart', { todayStart })
      .groupBy('q.campaign_id')
      .getRawMany<{ campaignId: string; count: string }>();
    return new Map(rows.map((r) => [r.campaignId, parseInt(r.count, 10)]));
  }

  findByCampaign(
    campaignId: string,
    limit = 200,
  ): Promise<WhatsappMessageQueue[]> {
    return this.repo.find({
      where: { campaign_id: campaignId },
      order: { scheduled_at: 'ASC' },
      take: limit,
    });
  }

  enqueue(dto: Partial<WhatsappMessageQueue>): Promise<WhatsappMessageQueue> {
    return this.repo.save(this.repo.create(dto));
  }

  async markProcessing(id: string): Promise<void> {
    this.logger.log(
      `[MKT_QUEUE_STATUS_UPDATE] id=${id} old=PENDING new=PROCESSING`,
    );
    this.logger.log(
      `[QUEUE_AUDIT] status_transition: id=${id} PENDING→PROCESSING`,
    );
    await this.repo.update(id, { status: QueueStatus.PROCESSING });
  }

  async markSent(id: string): Promise<void> {
    this.logger.log(
      `[MKT_QUEUE_STATUS_UPDATE] id=${id} old=PROCESSING new=SENT`,
    );
    this.logger.log(
      `[QUEUE_AUDIT] status_transition: id=${id} PROCESSING→SENT`,
    );
    await this.repo.update(id, {
      status: QueueStatus.SENT,
      sent_at: new Date(),
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.logger.log(
      `[MKT_QUEUE_STATUS_UPDATE] id=${id} old=PROCESSING new=FAILED error="${error.slice(0, 80)}"`,
    );
    this.logger.warn(
      `[QUEUE_AUDIT] status_transition: id=${id} PROCESSING→FAILED error="${error.slice(0, 120)}"`,
    );
    await this.repo.increment({ id }, 'attempt_count', 1);
    await this.repo.update(id, {
      status: QueueStatus.FAILED,
      error_message: error,
    });
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    const code = normalizeSkipReason(reason);
    this.logger.log(
      `[MKT_QUEUE_STATUS_UPDATE] id=${id} old=PROCESSING new=SKIPPED reason=${code} detail="${reason.slice(0, 80)}"`,
    );
    this.logger.warn(
      `[QUEUE_AUDIT] status_transition: id=${id} PROCESSING→SKIPPED reason=${code} detail="${reason.slice(0, 120)}"`,
    );
    await this.repo.update(id, {
      status: QueueStatus.SKIPPED,
      error_message: code,
    });
  }

  // Persists the actual sender selected by the pool onto the queue row.
  // Called immediately after pool selection so every outcome (SENT/SKIPPED/FAILED/DEFERRED)
  // carries full sender traceability. Denormalized for historical stability.
  async assignSender(
    id: string,
    numberId: string,
    phone: string,
    name: string,
  ): Promise<void> {
    await this.repo.update(id, {
      actual_sender_number_id: numberId,
      actual_sender_phone: phone,
      actual_sender_name: name,
    });
  }

  // Merges patch into the jsonb message_payload of a queue row.
  // Used by AI template path to store generated_message + metadata after send-time generation.
  async patchPayload(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.repo.findOne({
      where: { id },
      select: ['id', 'message_payload'],
    });
    if (!row) return;
    await this.repo.update(id, {
      message_payload: { ...(row.message_payload ?? {}), ...patch },
    });
  }

  // Returns item to PENDING with scheduled_at deferred by deferMs (default 1 hour).
  // Used for rate-limit gates that are transient — item should retry next window, not be discarded.
  async markDeferred(
    id: string,
    reason: string,
    deferMs = 60 * 60_000,
  ): Promise<void> {
    const deferUntil = new Date(Date.now() + deferMs);
    this.logger.log(
      `[MKT_QUEUE_STATUS_UPDATE] id=${id} old=PROCESSING new=PENDING(deferred) until=${deferUntil.toISOString()} reason="${reason.slice(0, 80)}"`,
    );
    await this.repo.update(id, {
      status: QueueStatus.PENDING,
      scheduled_at: deferUntil,
      error_message: reason,
    });
  }

  // Cancel all PENDING items for a campaign (called when campaign is cancelled)
  /** Returns terminal and active row counts for a campaign — used by completion evaluation. */
  async getCampaignQueueCounts(campaignId: string): Promise<{
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    skipped: number;
  }> {
    const rows: { status: string; cnt: string }[] = await this.repo
      .createQueryBuilder('q')
      .select('q.status', 'status')
      .addSelect('COUNT(*)', 'cnt')
      .where('q.campaign_id = :id', { id: campaignId })
      .groupBy('q.status')
      .getRawMany();
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = parseInt(r.cnt, 10);
    return {
      pending: m[QueueStatus.PENDING] ?? 0,
      processing: m[QueueStatus.PROCESSING] ?? 0,
      sent:
        (m[QueueStatus.SENT] ?? 0) +
        (m[QueueStatus.DELIVERED] ?? 0) +
        (m[QueueStatus.READ] ?? 0) +
        (m[QueueStatus.REPLIED] ?? 0),
      failed: m[QueueStatus.FAILED] ?? 0,
      skipped: m[QueueStatus.SKIPPED] ?? 0,
    };
  }

  async cancelCampaignQueue(campaignId: string): Promise<void> {
    await this.repo.update(
      { campaign_id: campaignId, status: QueueStatus.PENDING },
      { status: QueueStatus.SKIPPED, error_message: SkipReason.UNKNOWN_ERROR },
    );
  }

  async bulkEnqueue(items: Partial<WhatsappMessageQueue>[]): Promise<number> {
    if (!items.length) return 0;
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(WhatsappMessageQueue)
      .values(items as any)
      .execute();
    return items.length;
  }

  // Build queue items from eligible audience for a campaign launch
  async buildFromCampaign(campaign: MarketingCampaign): Promise<number> {
    this.logger.log(
      `[QUEUE_AUDIT] buildFromCampaign entry: campaign_id=${campaign.id} name="${campaign.campaign_name}" ` +
        `status=${campaign.status} test_mode=${campaign.test_mode} ` +
        `daily_target=${campaign.daily_target} is_promotion=${campaign.is_promotion} ` +
        `random_delay_min=${campaign.random_delay_min} random_delay_max=${campaign.random_delay_max}`,
    );
    this.logger.log(
      `[MKT_QUEUE_BUILD_START] campaign_id=${campaign.id} test_mode=${campaign.test_mode} ` +
        `daily_target=${campaign.daily_target} is_promotion=${campaign.is_promotion} ` +
        `random_delay_min=${campaign.random_delay_min} random_delay_max=${campaign.random_delay_max}`,
    );
    const { start: todayStart } = getIstDayBounds();

    // Round-robin assignment — only numbers with a live, verified WA session
    const allNumbers = await this.numbersService.findAll();
    // wa_state === 'ready' DB check intentionally removed: the DB value lags behind
    // in-memory state during startup pre-reset and _scheduleReconnect teardown, causing
    // queue builds to skip numbers that are actually connected. isConnected() is the
    // authoritative in-memory check and is sufficient here.
    const sendableNumbers = allNumbers.filter(
      (n) =>
        n.is_active &&
        n.status === WhatsAppNumberStatus.ACTIVE &&
        this.whatsAppService.getNumberState(n.id) ===
          NumberConnectionState.CONNECTED,
    );
    this.logger.log(
      `[MKT_QUEUE_GATE] campaign=${campaign.id} numbers_total=${allNumbers.length} ` +
        `sendable=${sendableNumbers.length} db_ready=${allNumbers.filter((n) => n.wa_state === 'ready').length} ` +
        `in_memory_connected=${sendableNumbers.length}`,
    );
    if (!sendableNumbers.length) {
      this.logger.warn(
        '[MKT_QUEUE_GATE] reason=no_connected_numbers — zero sendable numbers; skipping campaign queue build',
      );
      this.logger.warn(
        `[QUEUE_AUDIT] buildFromCampaign BLOCKED: campaign_id=${campaign.id} reason=no_sendable_numbers total_numbers=${allNumbers.length}`,
      );
      return 0;
    }

    // ── TEST MODE: bypass customer DB, queue exactly 6 hardcoded test phones ────
    if (campaign.test_mode) {
      return this._buildTestModeQueue(campaign, sendableNumbers);
    }

    // ── NORMAL / PROMOTION MODE ──────────────────────────────────────────────────

    // Hard cap: count ALL queue rows created today for this campaign (any status).
    const todayTotal = await this.repo.count({
      where: {
        campaign_id: campaign.id,
        created_at: MoreThanOrEqual(todayStart),
      },
    });
    if (todayTotal >= campaign.daily_target) {
      return 0;
    }
    const remaining = campaign.daily_target - todayTotal;

    const audience = await this.audienceService.findEligible();

    // Dedup: phones already queued today for ANY campaign (cross-campaign dedup prevents
    // the same customer receiving messages from two different campaigns on the same day).
    const allTodayPhones = await this.findActivePhonesSet();
    const existingPhones: Set<string> = allTodayPhones;

    // Catalog product lookup — populates product render fields in payload
    let catalogItem: ShopifyCatalogItem | null = null;
    if (campaign.product_id) {
      catalogItem = await this.catalogRepo
        .findOne({ where: { id: campaign.product_id, syncIgnored: false } })
        .catch(() => null);
    }

    const now = new Date();
    // Start stagger cursor from now — sender's isWithinSendWindow() gate handles window
    // enforcement. The old logic (start from send_window_start, push +24h if past) was
    // pushing every row to tomorrow when campaigns are launched after 10 AM.
    let cursor = new Date(now.getTime());

    const queuedByNumberRows = await this.repo
      .createQueryBuilder('q')
      .select('q.number_id', 'number_id')
      .addSelect('COUNT(*)', 'cnt')
      .where('q.created_at >= :todayStart', { todayStart })
      .andWhere('q.number_id IS NOT NULL')
      .groupBy('q.number_id')
      .getRawMany<{ number_id: string; cnt: string }>();
    const queuedTodayByNumber = new Map(
      queuedByNumberRows.map(
        (r) => [r.number_id, parseInt(r.cnt, 10)] as [string, number],
      ),
    );

    const matureCap = getMatureDailyCapacity();
    const allocatedPerNumber: Record<string, number> = {};
    for (const n of sendableNumbers) allocatedPerNumber[n.id] = 0;
    let numberCursor = 0;

    const items: Partial<WhatsappMessageQueue>[] = [];
    for (const member of audience) {
      if (existingPhones.has(member.phone)) continue;
      if (items.length >= remaining) break;

      let number: (typeof sendableNumbers)[0] | null = null;
      for (let i = 0; i < sendableNumbers.length; i++) {
        const candidate =
          sendableNumbers[(numberCursor + i) % sendableNumbers.length];
        const queued = queuedTodayByNumber.get(candidate.id) ?? 0;
        if (queued + (allocatedPerNumber[candidate.id] ?? 0) < matureCap) {
          number = candidate;
          numberCursor = (numberCursor + i + 1) % sendableNumbers.length;
          break;
        }
      }
      if (!number) break;

      const productFields = catalogItem
        ? {
            product_name: catalogItem.itemName ?? '',
            product_sku: catalogItem.sku ?? '',
            product_image: catalogItem.image ?? '',
            product_link: STORE_URL,
          }
        : {};

      items.push({
        campaign_id: campaign.id,
        template_id: campaign.template_id ?? undefined,
        number_id: number?.id ?? undefined,
        product_id: catalogItem?.id ?? undefined,
        customer_phone: member.phone,
        customer_id: member.customer_id ?? undefined,
        scheduled_at: new Date(cursor),
        status: QueueStatus.PENDING,
        priority: Math.round(Number(member.quality_score)),
        message_payload: {
          name: member.name ?? '',
          city: member.city ?? '',
          business_type: member.business_type ?? '',
          sender_phone: number?.phone ?? '',
          ...productFields,
        },
      });

      const delayMs =
        (campaign.random_delay_min +
          Math.random() *
            (campaign.random_delay_max - campaign.random_delay_min)) *
        1000;
      cursor = new Date(cursor.getTime() + delayMs);
      allocatedPerNumber[number.id]++;
    }

    if (!items.length) {
      this.logger.warn(
        `[QUEUE_AUDIT] buildFromCampaign ZERO_ITEMS: campaign_id=${campaign.id} audience_fetched=${audience.length} remaining_quota=${remaining} reason=all_phones_already_queued_or_audience_empty`,
      );
      return 0;
    }
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(WhatsappMessageQueue)
      .values(items as any)
      .execute();

    this.logger.log(
      `[QUEUE_AUDIT] buildFromCampaign SUCCESS: campaign_id=${campaign.id} ` +
        `inserted=${items.length} audience_total=${audience.length} ` +
        `deduped_phones=${audience.length - items.length} sendable_numbers=${sendableNumbers.length}`,
    );
    this.logger.log(
      `[PROMOTION_QUEUE_CREATED] campaign_id=${campaign.id} ` +
        `audience_count=${items.length} connected_numbers=${sendableNumbers.length} ` +
        `rotation_enabled=true test_mode=false is_promotion=${campaign.is_promotion}`,
    );
    this.logger.log(
      `[MKT_QUEUE_INSERT_DIAG] campaign_id=${campaign.id} test_mode=false count=${items.length} ` +
        `scheduled_ats=${JSON.stringify(items.map((i) => i.scheduled_at?.toISOString()))} ` +
        `statuses=${JSON.stringify(items.map((i) => i.status))}`,
    );

    return items.length;
  }

  // Builds queue items from dynamic test contacts (is_test_contact=true, opt_out=false,
  // is_whatsapp_valid=true). Replaces the former hardcoded TEST_PHONES list so recipients
  // can be managed via the audience table without code deployments.
  private async _buildTestModeQueue(
    campaign: MarketingCampaign,
    sendableNumbers: Awaited<ReturnType<NumbersService['findAll']>>,
  ): Promise<number> {
    const testContacts = await this.audienceService.findEligible(0, true);

    if (!testContacts.length) {
      this.logger.warn(
        `[TEST_MODE_NO_CONTACTS] campaign_id=${campaign.id} name="${campaign.campaign_name}" ` +
          `— no eligible test contacts found. ` +
          `Add audience rows with is_test_contact=true, opt_out=false, is_whatsapp_valid=true ` +
          `to run a test campaign.`,
      );
      return 0;
    }

    this.logger.log(
      `[TEST_MODE_CONTACTS_FOUND] campaign_id=${campaign.id} count=${testContacts.length} ` +
        `phones=${JSON.stringify(testContacts.map((c) => c.phone))}`,
    );

    const now = new Date();
    // Space test messages 15 seconds apart so they don't all fire simultaneously
    const items: Partial<WhatsappMessageQueue>[] = testContacts.map(
      (contact, idx) => {
        const number = sendableNumbers[idx % sendableNumbers.length];
        return {
          campaign_id: campaign.id,
          template_id: campaign.template_id ?? undefined,
          number_id: number?.id ?? undefined,
          customer_phone: contact.phone,
          customer_id: contact.customer_id ?? undefined,
          scheduled_at: new Date(now.getTime() + idx * 15_000),
          status: QueueStatus.PENDING,
          priority: 100,
          message_payload: {
            name: contact.name ?? '',
            city: contact.city ?? '',
            business_type: contact.business_type ?? '',
            sender_phone: number?.phone ?? '',
          },
        };
      },
    );

    await this.repo
      .createQueryBuilder()
      .insert()
      .into(WhatsappMessageQueue)
      .values(items as any)
      .execute();

    this.logger.log(
      `[PROMOTION_QUEUE_CREATED] campaign_id=${campaign.id} ` +
        `audience_count=${items.length} connected_numbers=${sendableNumbers.length} ` +
        `rotation_enabled=true test_mode=true is_promotion=${campaign.is_promotion}`,
    );
    this.logger.log(
      `[MKT_QUEUE_INSERT_DIAG] campaign_id=${campaign.id} test_mode=true count=${items.length} ` +
        `scheduled_ats=${JSON.stringify(items.map((i) => i.scheduled_at?.toISOString()))} ` +
        `statuses=${JSON.stringify(items.map((i) => i.status))}`,
    );

    return items.length;
  }
}

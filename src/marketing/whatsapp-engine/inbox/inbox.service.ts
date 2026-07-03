import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

/**
 * Converts any Indian phone variant to canonical E.164 (+91XXXXXXXXXX).
 * Mirrors the CRM normalizePhone() logic so both sides of every DB lookup
 * are compared in the same format.
 *
 * Input examples → +919884052555:
 *   9884052555      (10 digits)
 *   09884052555     (11 digits, leading 0)
 *   919884052555    (12 digits, country code without +)
 *   +919884052555   (already canonical)
 */
function canonicalPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  if (d.length === 13 && d.startsWith('091')) return `+${d.slice(1)}`;
  return `+${d}`;
}
import { WhatsappReply } from '../entities/whatsapp-reply.entity';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';
import { WhatsappNumber } from '../entities/whatsapp-number.entity';
import { MarketingAudience } from '../entities/marketing-audience.entity';
import { ReplyStatus, QueueStatus, MessageType } from '../entities/enums';
import { MarketingWhatsAppService } from '../marketing-whatsapp.service';

export interface ConversationSummary {
  conversation_key: string;
  customer_phone: string;
  customer_name: string | null;
  number_id: string | null;
  latest_message: string;
  latest_message_at: Date;
  unread_count: number;
  message_count: number;
  latest_reply_id: string;
  crm_lead_created: boolean;
  crm_lead_id: number | null;
  /** CUSTOMER_DB | PROMO_DB | UNKNOWN */
  customer_source: string;
}

export interface ConversationMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  timestamp: Date;
  number_id: string | null;
  number_phone?: string | null;
  crm_lead_created?: boolean;
  crm_lead_id?: number | null;
  is_read?: boolean;
}

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    @InjectRepository(WhatsappReply)
    private repo: Repository<WhatsappReply>,
    @InjectRepository(WhatsappMessageLog)
    private logRepo: Repository<WhatsappMessageLog>,
    @InjectRepository(WhatsappNumber)
    private numberRepo: Repository<WhatsappNumber>,
    @InjectRepository(MarketingAudience)
    private audienceRepo: Repository<MarketingAudience>,
    private readonly whatsAppService: MarketingWhatsAppService,
  ) {}

  async findAll(): Promise<ConversationSummary[]> {
    // Group by customer_phone only (not conversation_key) so the same customer
    // appears exactly once even if they've messaged via multiple telecaller numbers.
    const rows: ConversationSummary[] = await this.repo.manager.query(`
      WITH latest AS (
        SELECT DISTINCT ON (customer_phone)
          customer_phone AS conversation_key,
          id             AS latest_reply_id,
          message        AS latest_message,
          number_id,
          customer_name
        FROM whatsapp_replies
        WHERE customer_phone IS NOT NULL
        ORDER BY customer_phone, received_at DESC
      ),
      agg AS (
        SELECT
          customer_phone,
          MAX(received_at)                                                       AS latest_message_at,
          SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END)::int                 AS unread_count,
          COUNT(*)::int                                                          AS message_count,
          BOOL_OR(crm_lead_created)                                              AS crm_lead_created,
          MAX(crm_lead_id)                                                       AS crm_lead_id
        FROM whatsapp_replies
        WHERE customer_phone IS NOT NULL
        GROUP BY customer_phone
      )
      SELECT
        a.customer_phone  AS conversation_key,
        a.customer_phone,
        COALESCE(
          NULLIF(cust."companyName", ''),
          NULLIF(cust."contactName", ''),
          l.customer_name
        ) AS customer_name,
        l.number_id,
        l.latest_message,
        a.latest_message_at,
        a.unread_count,
        a.message_count,
        l.latest_reply_id,
        a.crm_lead_created,
        a.crm_lead_id,
        CASE
          WHEN cust.id IS NOT NULL                         THEN 'CUSTOMER_DB'
          WHEN ma.id  IS NOT NULL                          THEN 'PROMO_DB'
          ELSE                                                  'UNKNOWN'
        END AS customer_source
      FROM agg a
      JOIN latest l ON l.conversation_key = a.customer_phone
      LEFT JOIN LATERAL (
        SELECT id, "companyName", "contactName"
        FROM customer
        WHERE REGEXP_REPLACE(mobile1, '[^0-9]', '', 'g')
            = REGEXP_REPLACE(a.customer_phone, '[^0-9]', '', 'g')
        LIMIT 1
      ) cust ON true
      LEFT JOIN LATERAL (
        SELECT id
        FROM marketing_audience
        WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g')
            = REGEXP_REPLACE(a.customer_phone, '[^0-9]', '', 'g')
          AND (source IS NULL OR source != 'WHATSAPP_INBOX')
        LIMIT 1
      ) ma ON true
      ORDER BY a.latest_message_at DESC
      LIMIT 200
    `);

    this.logger.log(
      `[INBOX_GROUPING] conversation_count=${rows.length} ` +
        `unread_conversations=${rows.filter((r) => r.unread_count > 0).length} ` +
        `total_unread=${rows.reduce((s, r) => s + Number(r.unread_count), 0)}`,
    );

    return rows;
  }

  findByPhone(phone: string): Promise<WhatsappReply[]> {
    return this.repo.find({
      where: { customer_phone: phone },
      order: { received_at: 'DESC' },
    });
  }

  async markLeadCreated(id: string, leadId: number): Promise<WhatsappReply> {
    const reply = await this.repo.findOne({ where: { id } });
    if (!reply) throw new NotFoundException(`Reply ${id} not found`);
    await this.repo.update(id, { crm_lead_created: true, crm_lead_id: leadId });
    await this.audienceRepo.update(
      { phone: reply.customer_phone },
      { reply_status: ReplyStatus.LEAD_CREATED, last_reply_at: new Date() },
    );
    return this.repo.findOne({ where: { id } });
  }

  async markRead(id: string): Promise<void> {
    await this.repo.update(id, { is_read: true });
  }

  // Send a reply to the customer via the same number that received their message.
  // Falls back to any connected number if number_id is unset.
  async sendReply(
    replyId: string,
    message: string,
  ): Promise<{ sent: boolean; log_id?: string }> {
    const reply = await this.repo.findOne({ where: { id: replyId } });
    if (!reply) throw new NotFoundException(`Reply ${replyId} not found`);

    let numberId = reply.number_id;

    // Fallback: find a number whose WA client is live in memory (waState=ready)
    if (!numberId) {
      const activeNumbers = await this.numberRepo.find({
        where: { is_active: true },
      });
      const liveNumber = activeNumbers.find((n) =>
        this.whatsAppService.isConnected(n.id),
      );
      numberId = liveNumber?.id ?? null;
    }

    if (!numberId) {
      throw new Error('No connected WhatsApp number available to send reply');
    }

    // Validate client health before attempting send — aborts on corrupted browser/session
    await this.whatsAppService.assertHealthyClient(numberId);

    const waResult = await this.whatsAppService.sendViaNumber(
      numberId,
      reply.customer_phone,
      message,
    );
    const waMessageId: string | null =
      waResult?.id?._serialized ?? waResult?.id ?? null;

    // Log the outbound message to WhatsappMessageLog for full conversation context
    const logRow = await this.logRepo.save(
      this.logRepo.create({
        number_id: numberId,
        customer_phone: reply.customer_phone,
        message_type: MessageType.TEXT,
        message_body: message,
        status: QueueStatus.SENT,
        sent_at: new Date(),
      }),
    );

    // Bridge ACK race for inbox replies: register before DB write, deregister after.
    if (waMessageId) {
      this.whatsAppService.registerPendingAck(waMessageId, logRow.id);
      await this.logRepo.update(logRow.id, { wa_message_id: waMessageId });
      this.whatsAppService.deregisterPendingAck(waMessageId);
    }

    // Mark original reply as read since operator just responded
    await this.repo.update(replyId, { is_read: true });

    this.logger.log(
      `[MKT_INBOX_REPLY] replyId=${replyId} phone=${reply.customer_phone} ` +
        `number_id=${numberId} log_id=${logRow.id} wa_message_id=${waMessageId ?? 'none'}`,
    );

    return { sent: true, log_id: logRow.id };
  }

  // Returns merged INBOUND (WhatsappReply) + OUTBOUND (WhatsappMessageLog) for a phone,
  // sorted chronologically. Gives a full conversation thread view from the inbox.
  async getConversation(phone: string): Promise<ConversationMessage[]> {
    const [repliesDesc, logs, numbers] = await Promise.all([
      this.repo.find({
        where: { customer_phone: phone },
        order: { received_at: 'DESC' },
        take: 300,
      }),
      this.logRepo.find({
        where: { customer_phone: phone },
        order: { sent_at: 'ASC' },
        take: 100,
      }),
      this.numberRepo.find(),
    ]);

    // Re-sort ascending after DESC-limited fetch so thread renders chronologically
    const replies = repliesDesc.reverse();

    const numberMap = new Map<string, string>(
      numbers.map((n) => [n.id, n.phone]),
    );

    const inbound: ConversationMessage[] = replies.map((r) => ({
      id: r.id,
      direction: 'INBOUND',
      body: r.message,
      timestamp: r.received_at,
      number_id: r.number_id,
      number_phone: r.number_id ? (numberMap.get(r.number_id) ?? null) : null,
      crm_lead_created: r.crm_lead_created,
      crm_lead_id: r.crm_lead_id,
      is_read: r.is_read,
    }));

    const outbound: ConversationMessage[] = logs
      .filter((l) => l.message_body && l.sent_at)
      .map((l) => ({
        id: l.id,
        direction: 'OUTBOUND',
        body: l.message_body ?? '',
        timestamp: l.sent_at,
        number_id: l.number_id,
        number_phone: l.number_id ? (numberMap.get(l.number_id) ?? null) : null,
      }));

    const result = [...inbound, ...outbound].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    this.logger.log(
      `[INBOX_THREAD] phone=${phone} message_count=${result.length} ` +
        `inbound=${inbound.length} outbound=${outbound.length}`,
    );

    return result;
  }

  // Priority: CRM customer → customer_phones → marketing_audience → leads → null
  // EXACT normalized equality only — no LIKE, no substring, no ILIKE.
  private async resolveCustomerName(phone: string): Promise<{
    name: string;
    source: string;
    matchedId: string | number;
  } | null> {
    const normalized = canonicalPhone(phone);
    const digits = normalized.replace(/\D/g, '');

    // P1: customer.mobile1 (primary phone)
    try {
      const rows: { id: number; companyName: string; contactName: string }[] =
        await this.repo.manager.query(
          `SELECT id, "companyName", "contactName" FROM customer
           WHERE REGEXP_REPLACE(mobile1, '[^0-9]', '', 'g') = $1
           LIMIT 1`,
          [digits],
        );
      if (rows.length > 0) {
        const r = rows[0];
        const name = r.companyName || r.contactName || null;
        this.logger.log(
          `[CUSTOMER_LOOKUP] incomingPhone=${phone} normalizedPhone=${normalized} ` +
            `source=customer.mobile1 matchedId=${r.id} matchedRecord="${name}" reason=exact_match`,
        );
        if (name) return { name, source: 'customer.mobile1', matchedId: r.id };
      }
    } catch (e: any) {
      this.logger.warn(
        `[CUSTOMER_LOOKUP] customer.mobile1 query failed: ${e.message}`,
      );
    }

    // P1b: customer_phones (secondary phones)
    try {
      const rows: {
        customer_id: number;
        companyName: string;
        contactName: string;
      }[] = await this.repo.manager.query(
        `SELECT cp.customer_id, c."companyName", c."contactName"
           FROM customer_phones cp
           JOIN customer c ON c.id = cp.customer_id
           WHERE REGEXP_REPLACE(cp.phone, '[^0-9]', '', 'g') = $1
           LIMIT 1`,
        [digits],
      );
      if (rows.length > 0) {
        const r = rows[0];
        const name = r.companyName || r.contactName || null;
        this.logger.log(
          `[CUSTOMER_LOOKUP] incomingPhone=${phone} normalizedPhone=${normalized} ` +
            `source=customer_phones matchedId=${r.customer_id} matchedRecord="${name}" reason=exact_match`,
        );
        if (name)
          return { name, source: 'customer_phones', matchedId: r.customer_id };
      }
    } catch (e: any) {
      this.logger.warn(
        `[CUSTOMER_LOOKUP] customer_phones query failed: ${e.message}`,
      );
    }

    // P2: marketing_audience
    try {
      const audience = await this.audienceRepo
        .findOne({ where: { phone: normalized } })
        .catch(() => null);
      if (audience?.name) {
        this.logger.log(
          `[CUSTOMER_LOOKUP] incomingPhone=${phone} normalizedPhone=${normalized} ` +
            `source=marketing_audience matchedId=${audience.id} matchedRecord="${audience.name}" reason=exact_match`,
        );
        return {
          name: audience.name,
          source: 'marketing_audience',
          matchedId: audience.id,
        };
      }
    } catch (e: any) {
      this.logger.warn(
        `[CUSTOMER_LOOKUP] marketing_audience query failed: ${e.message}`,
      );
    }

    // P3: leads
    try {
      const rows: { id: number; name: string }[] =
        await this.repo.manager.query(
          `SELECT id, name FROM leads
           WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1
           AND name IS NOT NULL AND name != ''
           ORDER BY id DESC LIMIT 1`,
          [digits],
        );
      if (rows.length > 0) {
        const r = rows[0];
        this.logger.log(
          `[CUSTOMER_LOOKUP] incomingPhone=${phone} normalizedPhone=${normalized} ` +
            `source=leads matchedId=${r.id} matchedRecord="${r.name}" reason=exact_match`,
        );
        return { name: r.name, source: 'leads', matchedId: r.id };
      }
    } catch (e: any) {
      this.logger.warn(`[CUSTOMER_LOOKUP] leads query failed: ${e.message}`);
    }

    this.logger.log(
      `[CUSTOMER_LOOKUP] incomingPhone=${phone} normalizedPhone=${normalized} ` +
        `source=none matchedId=null matchedRecord=null reason=no_match`,
    );
    return null;
  }

  // Called internally when an inbound WA message arrives from a marketing-linked number
  async saveReply(dto: Partial<WhatsappReply>): Promise<WhatsappReply> {
    const phone = dto.customer_phone ?? '';
    const digits = phone.replace(/\D/g, '');
    const isValidE164 =
      phone.startsWith('+') &&
      digits.length >= 10 &&
      digits.length <= 15 &&
      /^\+[1-9]\d{9,14}$/.test(phone);

    if (!isValidE164) {
      this.logger.warn(
        `[MKT_REPLY_SAVE_BLOCKED] phone="${phone}" digits=${digits.length} — ` +
          `failed E.164 validation; row not inserted`,
      );
      throw new Error(`[MKT_REPLY_SAVE_BLOCKED] Invalid phone: "${phone}"`);
    }

    // Compute conversation thread key: normalized phone + receiving number
    const conversationKey = `${phone}|${dto.number_id ?? ''}`;

    // Resolve customer name — CRM always wins over marketing_audience display name
    if (!dto.customer_name) {
      const resolved = await this.resolveCustomerName(phone);
      if (resolved) {
        dto = { ...dto, customer_name: resolved.name };
      }
    }

    const saved = await this.repo.save(
      this.repo.create({ ...dto, conversation_key: conversationKey }),
    );

    this.logger.log(
      `[INBOX_RECEIVE] phone=${phone} conversation_key=${conversationKey} ` +
        `number_id=${dto.number_id ?? 'n/a'} customer_name=${saved.customer_name ?? 'none'} ` +
        `message="${(dto.message ?? '').slice(0, 60)}"`,
    );

    // Upsert marketing_audience: create with source=WHATSAPP_INBOX for unknown numbers,
    // or update reply_status on existing records.
    if (dto.customer_phone) {
      const existing = await this.audienceRepo.findOne({
        where: { phone: dto.customer_phone },
      });
      if (existing) {
        await this.audienceRepo.update(existing.id, {
          reply_status: ReplyStatus.REPLIED,
          last_reply_at: new Date(),
        });
      } else {
        try {
          await this.audienceRepo.save(
            this.audienceRepo.create({
              phone: dto.customer_phone,
              name: saved.customer_name ?? null,
              customer_name: saved.customer_name ?? null,
              source: 'WHATSAPP_INBOX',
              reply_status: ReplyStatus.REPLIED,
              last_reply_at: new Date(),
              is_whatsapp_valid: true,
            }),
          );
          this.logger.log(
            `[INBOX_AUTO_AUDIENCE] phone=${dto.customer_phone} created source=WHATSAPP_INBOX`,
          );
        } catch (e: any) {
          // 23505 = unique_violation — another message from the same number raced us
          if (e.code !== '23505') {
            this.logger.warn(
              `[INBOX_AUTO_AUDIENCE] insert failed for phone=${dto.customer_phone}: ${e.message}`,
            );
          }
        }
      }
    }
    return saved;
  }

  // Product search for telecaller use inside inbox — queries Shopify catalog only
  async searchProducts(q: string): Promise<
    Array<{
      id: number;
      itemName: string;
      sku: string;
      retailPrice: number;
      image: string | null;
      handle: string | null;
    }>
  > {
    if (!q || q.trim().length < 1) return [];
    const like = `%${q.trim()}%`;
    return this.repo.manager.query(
      `SELECT id, item_name AS "itemName", sku,
              retail_price::float AS "retailPrice", image, handle
       FROM shopify_catalog_items
       WHERE (item_name ILIKE $1 OR sku ILIKE $1)
         AND sync_ignored = false
       ORDER BY sku ASC
       LIMIT 10`,
      [like],
    );
  }
}

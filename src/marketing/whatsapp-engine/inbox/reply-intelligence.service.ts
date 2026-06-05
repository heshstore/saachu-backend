import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InboxService } from './inbox.service';
import { AudienceAiService } from '../ai/audience-ai.service';
import { LeadSource } from '../../../crm/entities/lead.entity';
import { MessageType } from '../entities/enums';
import { WhatsappMessageLog } from '../entities/whatsapp-message-log.entity';

@Injectable()
export class ReplyIntelligenceService {
  private readonly logger = new Logger(ReplyIntelligenceService.name);

  // Dedup window: don't create a second WHATSAPP lead for the same phone within this many days
  private static readonly DEDUP_DAYS = 7;

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
    @InjectRepository(WhatsappMessageLog)
    private readonly logRepo: Repository<WhatsappMessageLog>,
    private readonly inboxService: InboxService,
    private readonly eventEmitter: EventEmitter2,
    private readonly audienceAi: AudienceAiService,
  ) {}

  // Listens only to marketing number inbound messages — namespaced away from CRM events.
  // CRM inbound messages emit crm.whatsapp.message.received and are handled by crm-whatsapp.service.ts only.
  @OnEvent('marketing.whatsapp.message.received')
  async handleInboundMessage(payload: {
    phone: string;
    body: string;
    chatId: string;
    name?: string;
    numberId?: string;
  }): Promise<void> {
    const { phone, body, chatId, name, numberId } = payload;

    // Hard gate — last-resort firewall before any DB write, websocket, or lead creation.
    // Rejects: empty, @-containing strings, <10 digits, >15 digits, or non-E164 patterns.
    const phoneDigits = (phone ?? '').replace(/\D/g, '');
    const phoneIsValid = !!phone &&
      phoneDigits.length >= 10 &&
      phoneDigits.length <= 15 &&
      /^\+?[1-9]\d{9,14}$/.test(phone);

    if (!phoneIsValid) {
      this.logger.warn(
        `[MKT_INBOX_BLOCK_INVALID_PHONE] raw=${payload.chatId ?? 'n/a'} resolved=${phone} ` +
        `digit_count=${phoneDigits.length} — rejected at hard gate; no row inserted`,
      );
      this.logger.warn(`[INBOX_AUDIT] message_dropped: chatId=${payload.chatId ?? 'n/a'} resolved_phone="${phone}" reason=invalid_phone_format digit_count=${phoneDigits.length}`);
      return;
    }

    this.logger.log(`[INBOX_AUDIT] message_received: phone=${phone} number_id=${numberId ?? 'none'} body_len=${body.length} body="${body.slice(0, 80)}"`);

    // 1. Save reply to marketing inbox
    try {
      await this.inboxService.saveReply({
        customer_phone: phone,
        customer_name: name ?? null,
        message: body,
        message_type: MessageType.TEXT,
        received_at: new Date(),
        number_id: numberId ?? null,
      });
      this.logger.log(`[MKT_INBOX_DB_SAVE] phone=${phone} message="${body.slice(0, 80)}"`);
      this.logger.log(`[INBOX_AUDIT] message_saved: phone=${phone} number_id=${numberId ?? 'none'}`);
    } catch (err: any) {
      this.logger.warn(`[ReplyIntelligence] Failed to save reply for ${phone}: ${err?.message}`);
      this.logger.error(`[INBOX_AUDIT] message_save_failed: phone=${phone} error="${err?.message}"`);
    }

    // 1b. Link reply back to the most recent sent log row for this phone.
    // Outbound queue items store phones without leading + (e.g. "917010366206") while the
    // inbox resolves canonical E.164 with + ("+917010366206"). Match both forms so the
    // reply_received flag is set correctly and the replied analytics count is non-zero.
    try {
      const phoneStripped = phone.replace(/^\+/, '');
      const recentLog = await this.logRepo.findOne({
        where: [
          { customer_phone: phone },
          { customer_phone: phoneStripped },
        ],
        order: { sent_at: 'DESC' },
      });
      if (recentLog) {
        await this.logRepo.update(recentLog.id, {
          reply_received: true,
          reply_message: body.slice(0, 500),
        });
        this.logger.log(`[MKT_INBOX_LOG_LINKBACK] log_id=${recentLog.id} phone=${phone}`);
        this.logger.log(`[INBOX_AUDIT] log_linkback_ok: phone=${phone} linked_log_id=${recentLog.id}`);
      } else {
        this.logger.log(`[INBOX_AUDIT] log_linkback_miss: phone=${phone} — no prior outbound log found (unsolicited reply or new contact)`);
      }
    } catch (err: any) {
      this.logger.warn(`[ReplyIntelligence] Log linkback failed for ${phone}: ${err?.message}`);
      this.logger.warn(`[INBOX_AUDIT] log_linkback_failed: phone=${phone} error="${err?.message}"`);
    }

    // 2. Classify intent
    const intent = this.classifyIntent(body);

    // 3. Handle opt-out
    if (intent === 'opt_out') {
      this.logger.log(`[ReplyIntelligence] Opt-out detected for ${phone}`);
      return;
    }

    this.logger.log(`[INBOX_AUDIT] intent_classified: phone=${phone} intent=${intent}`);

    // 4. If interested: reset cooldown, then create CRM lead via event bus (no direct module coupling)
    if (intent === 'interested') {
      try {
        await this.audienceAi.resetCooldown(phone);
      } catch { /* audience member may not exist yet — fine */ }
      await this._createCrmLead(phone, body, name, chatId);
    }
  }

  classifyIntent(body: string): 'interested' | 'opt_out' | 'neutral' {
    if (/stop|block|remove me|unsubscribe|not interested/i.test(body)) {
      return 'opt_out';
    }
    if (/price|cost|rate|how much|kitna|catalog|catalogue|brochure|moq|minimum|call me|interested|want|need|order|buy|purchase|details|info|yes\b|ok\b/i.test(body)) {
      return 'interested';
    }
    return 'neutral';
  }

  async _createCrmLead(phone: string, body: string, name?: string, chatId?: string): Promise<void> {
    // Dedup: skip if a WHATSAPP lead for this phone already exists within the dedup window
    try {
      const cutoff = new Date(Date.now() - ReplyIntelligenceService.DEDUP_DAYS * 24 * 3600 * 1000);
      const existing: { count: string }[] = await this.ds.query(
        `SELECT COUNT(*) AS count FROM leads WHERE phone = $1 AND source = $2 AND created_at >= $3`,
        [phone, LeadSource.WHATSAPP, cutoff],
      );
      if (parseInt(existing[0]?.count ?? '0', 10) > 0) {
        this.logger.log(`[ReplyIntelligence] Dedup skip — existing WHATSAPP lead for ${phone} within ${ReplyIntelligenceService.DEDUP_DAYS} days`);
        return;
      }
    } catch (err: any) {
      this.logger.warn(`[ReplyIntelligence] Dedup check failed for ${phone}: ${err?.message}`);
    }

    // Emit lead.incoming — consumed by LeadService.handleIncomingLead() in CRM module.
    // This avoids a direct service import (LeadService) which would couple WhatsappEngineModule → CrmModule.
    // raw_payload.body is what LeadService.handleIncomingLead reads for the notes field.
    // The top-level `notes` key is not in the handler's payload type and was silently ignored.
    this.eventEmitter.emit('lead.incoming', {
      phone,
      name,
      source:           LeadSource.WHATSAPP,
      whatsapp_chat_id: chatId,
      raw_payload:      { body, message: body },
    });

    this.logger.log(`[ReplyIntelligence] lead.incoming emitted for ${phone}`);
  }
}

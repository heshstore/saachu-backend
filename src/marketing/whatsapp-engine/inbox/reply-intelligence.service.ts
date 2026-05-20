import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InboxService } from './inbox.service';
import { LeadService } from '../../../crm/lead.service';
import { AudienceAiService } from '../ai/audience-ai.service';
import { CreateLeadDto } from '../../../crm/dto/create-lead.dto';
import { LeadSource } from '../../../crm/entities/lead.entity';
import { MessageType } from '../entities/enums';

@Injectable()
export class ReplyIntelligenceService {
  private readonly logger = new Logger(ReplyIntelligenceService.name);

  // Dedup window: don't create a second WHATSAPP lead for the same phone within this many days
  private static readonly DEDUP_DAYS = 7;

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
    private readonly inboxService: InboxService,
    private readonly leadService: LeadService,
    private readonly audienceAi: AudienceAiService,
  ) {}

  @OnEvent('whatsapp.message.received')
  async handleInboundMessage(payload: {
    phone: string;
    body: string;
    chatId: string;
    name?: string;
  }): Promise<void> {
    const { phone, body, chatId, name } = payload;

    // 1. Save reply to inbox
    try {
      await this.inboxService.saveReply({
        customer_phone: phone,
        customer_name: name ?? null,
        message: body,
        message_type: MessageType.TEXT,
        received_at: new Date(),
      });
    } catch (err: any) {
      this.logger.warn(`[ReplyIntelligence] Failed to save reply for ${phone}: ${err?.message}`);
    }

    // 2. Classify intent
    const intent = this.classifyIntent(body);

    // 3. Handle opt-out
    if (intent === 'opt_out') {
      this.logger.log(`[ReplyIntelligence] Opt-out detected for ${phone}`);
      return;
    }

    // 4. If interested: reset cooldown so they can receive follow-ups, then create CRM lead
    if (intent === 'interested') {
      try {
        await this.audienceAi.resetCooldown(phone);
      } catch { /* audience member may not exist yet — that's fine */ }
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

    const dto: CreateLeadDto = {
      phone,
      name,
      source: LeadSource.WHATSAPP,
      notes: `Marketing reply: "${body.slice(0, 200)}"`,
      context: 'WhatsApp Marketing Engine',
      whatsapp_chat_id: chatId,
    };

    try {
      const result = await this.leadService.create(dto, { role: 'Admin', id: null });
      this.logger.log(`[ReplyIntelligence] CRM lead created for ${phone}, lead id: ${(result as any)?.lead?.id ?? result}`);
    } catch (err: any) {
      this.logger.warn(`[ReplyIntelligence] Failed to create CRM lead for ${phone}: ${err?.message}`);
    }
  }
}

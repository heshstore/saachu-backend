import {
  Controller, Post, Get, Body, Headers, Query, Res, HttpCode, Logger, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/public.decorator';
import { LeadService } from './lead.service';
import { normalizeIndiaMart } from './normalizers/indiamart.normalizer';
import { normalizeMetaLead } from './normalizers/meta.normalizer';
import { normalizeShopify } from './normalizers/shopify.normalizer';
import { appConfig } from '../config/config';
import { Lead } from './entities/lead.entity';
import axios from 'axios';

const META_GRAPH_VERSION = 'v21.0';

type MetaLeadResponse = {
  field_data?: { name: string; values: string[] }[];
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
};

@Controller('leads/webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly leadService: LeadService) {}

  // ─── IndiaMart ───────────────────────────────────────────────────────────
  @Public()
  @Post('indiamart')
  @HttpCode(200)
  async indiaMart(@Body() body: any, @Headers('x-indiamart-secret') secret: string) {
    // Fail closed: require the secret to be configured AND match
    if (!appConfig.indiaMartSecretKey || secret !== appConfig.indiaMartSecretKey) {
      this.logger.warn('IndiaMart webhook: missing or invalid secret — ignoring');
      return { ok: true };
    }

    setImmediate(async () => {
      try {
        const dto = normalizeIndiaMart(body);
        if (!dto.phone) return;
        await this.leadService.create(dto as any, { id: null, role: 'Admin' });
      } catch (e) {
        this.logger.error('[IndiaMart] processing failed', e?.message);
      }
    });

    return { ok: true };
  }

  // ─── Meta — verification challenge ──────────────────────────────────────
  @Public()
  @Get('meta')
  metaVerify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === appConfig.metaVerifyToken) {
      this.logger.log('Meta webhook verified successfully');
      return res.status(200).send(challenge);
    }
    this.logger.warn('Meta webhook verification failed — token mismatch');
    return res.status(403).send('Forbidden');
  }

  // ─── Meta — lead event ───────────────────────────────────────────────────
  @Public()
  @Post('meta')
  @HttpCode(200)
  metaLead(
    @Body() body: any,
    @Headers('x-hub-signature-256') sig: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    this.logger.log('Meta webhook received');

    // Fail closed: require App Secret to be configured; verify HMAC always
    if (!appConfig.metaAppSecret) {
      this.logger.warn('Meta webhook: metaAppSecret not configured — rejecting all requests');
      return { ok: true };
    }

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const expected =
      'sha256=' +
      crypto
        .createHmac('sha256', appConfig.metaAppSecret)
        .update(rawBody)
        .digest('hex');

    if (!sig || sig !== expected) {
      this.logger.warn('Meta webhook: invalid signature — ignoring');
      return { ok: true };
    }

    // Respond 200 immediately; Meta retries if we take too long
    setImmediate(async () => {
      try {
        const entries = body?.entry ?? [];
        for (const entry of entries) {
          for (const change of entry?.changes ?? []) {
            const val = change?.value;
            if (!val?.leadgen_id) continue;

            const leadgenId = String(val.leadgen_id);
            this.logger.log(`Meta: processing leadgen_id=${leadgenId}`);

            // Idempotency — skip if already imported
            const existing = await this.leadService.findByExternalId(leadgenId);
            if (existing) {
              this.logger.log(`Meta: leadgen_id=${leadgenId} already exists (id=${existing.id}) — skipping`);
              continue;
            }

            // Fetch full lead data from Meta Graph API
            let graphData: MetaLeadResponse = {};
            try {
              const resp = await axios.get<MetaLeadResponse>(
                `https://graph.facebook.com/${META_GRAPH_VERSION}/${leadgenId}`,
                {
                  params: {
                    access_token: appConfig.metaAccessToken,
                    fields: 'field_data,ad_id,adset_id,campaign_id,ad_name,adset_name,campaign_name',
                  },
                },
              );
              graphData = resp.data;
              this.logger.log(`Meta: Graph API returned ${graphData.field_data?.length ?? 0} fields for ${leadgenId}`);
            } catch (err: any) {
              this.logger.error(`Meta: Graph API error for ${leadgenId}: ${err?.message}`);
            }

            const dto = normalizeMetaLead(graphData, leadgenId);
            this.logger.log(`Meta: normalized — name="${dto.name}" phone="${dto.phone}" email="${dto.email ?? ''}"`);

            if (!dto.phone) {
              this.logger.warn(`Meta: leadgen_id=${leadgenId} has no phone — skipping`);
              continue;
            }

            const { lead } = await this.leadService.create(dto as any, { id: null, role: 'Admin' });
            this.logger.log(`Meta: lead created id=${lead.id} for leadgen_id=${leadgenId}`);
            this.notifyNewLead(lead);
          }
        }
      } catch (e: any) {
        this.logger.error(`Meta: webhook processing failed — ${e?.message}`, e?.stack);
      }
    });

    return { ok: true };
  }

  // ─── Shopify contact form ─────────────────────────────────────────────────
  @Public()
  @Post('shopify')
  @HttpCode(200)
  shopify(
    @Body() body: any,
    @Headers('x-shopify-hmac-sha256') sig: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    // Fail closed: require webhook secret configured; Shopify signs with base64, not hex.
    if (!appConfig.shopifyWebhookSecret) {
      this.logger.warn('Shopify webhook: shopifyWebhookSecret not configured — rejecting all requests');
      return { ok: true };
    }

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const expected = crypto
      .createHmac('sha256', appConfig.shopifyWebhookSecret)
      .update(rawBody)
      .digest('base64');
    if (!sig || sig !== expected) {
      this.logger.warn('Shopify webhook: invalid HMAC — ignoring');
      return { ok: true };
    }

    this.logger.log('Shopify webhook received');

    setImmediate(async () => {
      try {
        const dto = normalizeShopify(body);
        if (!dto.phone && !dto.email) {
          this.logger.warn('Shopify webhook: no phone or email — skipping');
          return;
        }
        const { lead } = await this.leadService.create(dto as any, { id: null, role: 'Admin' });
        this.logger.log(`Shopify webhook: lead id=${lead.id} phone="${dto.phone}"`);
      } catch (e: any) {
        this.logger.error(`Shopify webhook processing failed: ${e?.message}`, e?.stack);
      }
    });

    return { ok: true };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private notifyNewLead(lead: Lead): void {
    const message = [
      '🔥 New Meta Lead',
      `Name: ${lead.name}`,
      `Phone: ${lead.phone}`,
      `Product: ${lead.product_interest || '-'}`,
      `Priority: ${lead.lead_priority}`,
      `Assigned to user id: ${lead.assigned_to ?? 'unassigned'}`,
      `Source: Meta Ads`,
    ].join('\n');

    this.logger.log(`[Meta Lead Notify]\n${message}`);
  }
}

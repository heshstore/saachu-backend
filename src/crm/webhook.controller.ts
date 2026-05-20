import {
  Controller, Post, Get, Body, Headers, Query, Res, HttpCode, Logger, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { LeadService } from './lead.service';
import { normalizeIndiaMart } from './normalizers/indiamart.normalizer';
import { normalizeMetaLead } from './normalizers/meta.normalizer';
import { normalizeGoogleLead } from './normalizers/google.normalizer';
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

// Healthy threshold: consider a source stale if no webhook received in this many hours.
const HEALTHY_THRESHOLD_HOURS = 24;

@Controller('leads/webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  // In-memory last-received timestamps. Process-local only — resets on restart.
  // Good enough for operator visibility; no persistence needed.
  private readonly lastReceived: Record<string, Date> = {};

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

    this.lastReceived['INDIAMART'] = new Date();

    setImmediate(async () => {
      try {
        const dto = normalizeIndiaMart(body);
        if (!dto.phone || dto.phone === 'unknown') return;
        const created = await this.leadService.create(dto as any, { id: null, role: 'Admin' });
        if (created.analyticsOnly) return;
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
    // Fail closed: require the verify token to be configured — rejects if env var is missing
    if (!appConfig.metaVerifyToken) {
      this.logger.warn('Meta webhook: META_VERIFY_TOKEN not configured — rejecting verification');
      return res.status(403).send('Forbidden');
    }
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

    this.lastReceived['META'] = new Date();

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
            if (!appConfig.metaAccessToken) {
              this.logger.warn(`Meta: META_ACCESS_TOKEN not configured — cannot fetch lead data for ${leadgenId}`);
            }
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

            if (!dto.phone || dto.phone === 'unknown') {
              this.logger.warn(`Meta: leadgen_id=${leadgenId} has no phone — skipping`);
              continue;
            }

            const created = await this.leadService.create(dto as any, { id: null, role: 'Admin' });
            if (created.analyticsOnly || !created.lead) {
              this.logger.warn(`Meta: leadgen_id=${leadgenId} blocked — no valid identity`);
              continue;
            }
            this.logger.log(`Meta: lead created id=${created.lead.id} for leadgen_id=${leadgenId}`);
            this.notifyNewLead(created.lead);
          }
        }
      } catch (e: any) {
        this.logger.error(`Meta: webhook processing failed — ${e?.message}`, e?.stack);
      }
    });

    return { ok: true };
  }

  // ─── Google Ads Lead Form Extension ─────────────────────────────────────
  @Public()
  @Post('google')
  @HttpCode(200)
  googleLead(@Body() body: any) {
    this.logger.log('Google Ads webhook received');

    // Fail closed: require the webhook key to be configured AND match
    if (!appConfig.googleAdsWebhookKey) {
      this.logger.warn('Google Ads webhook: GOOGLE_ADS_WEBHOOK_KEY not configured — rejecting all requests');
      return { ok: true };
    }
    if (body?.google_key !== appConfig.googleAdsWebhookKey) {
      this.logger.warn('Google Ads webhook: invalid google_key — ignoring');
      return { ok: true };
    }

    // Skip test submissions from Google's "Test" button in the UI
    if (body?.is_test === true) {
      this.logger.log(`Google Ads webhook: test submission lead_id=${body?.lead_id} — skipping`);
      return { ok: true };
    }

    const leadId = body?.lead_id ? String(body.lead_id) : null;
    if (!leadId) {
      this.logger.warn('Google Ads webhook: missing lead_id — ignoring');
      return { ok: true };
    }

    this.lastReceived['GOOGLE'] = new Date();

    setImmediate(async () => {
      try {
        // Idempotency — skip if already imported
        const existing = await this.leadService.findByExternalId(leadId);
        if (existing) {
          this.logger.log(`Google Ads: lead_id=${leadId} already exists (id=${existing.id}) — skipping`);
          return;
        }

        const dto = normalizeGoogleLead(body);
        this.logger.log(`Google Ads: normalized — name="${dto.name}" phone="${dto.phone}" campaign="${dto.utm_campaign ?? ''}"`);

        if (!dto.phone || dto.phone === 'unknown') {
          this.logger.warn(`Google Ads: lead_id=${leadId} has no phone — skipping`);
          return;
        }

        const created = await this.leadService.create(dto as any, { id: null, role: 'Admin' });
        if (created.analyticsOnly || !created.lead) {
          this.logger.warn(`Google Ads: lead_id=${leadId} blocked by identity gate`);
          return;
        }
        this.logger.log(`Google Ads: lead created id=${created.lead.id} for lead_id=${leadId}`);
      } catch (e: any) {
        this.logger.error(`Google Ads: webhook processing failed — ${e?.message}`, e?.stack);
      }
    });

    return { ok: true };
  }

  /**
   * @deprecated Use POST /api/leads/shopify (theme JS). Kept for legacy Shopify admin webhooks.
   * Routes through createFromShopifyClick() for the same identity rules as the primary path.
   */
  @Public()
  @Post('shopify')
  @HttpCode(200)
  shopify(
    @Body() body: any,
    @Headers('x-shopify-hmac-sha256') sig: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    this.logger.warn(
      '[DEPRECATED_INGEST] route=POST /leads/webhook/shopify reason=migrate_to_api_leads_shopify',
    );

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

    this.lastReceived['SHOPIFY'] = new Date();

    setImmediate(async () => {
      try {
        const result = await this.leadService.createFromShopifyClick({
          name: body.name || body.contact_name,
          phone: body.phone || body.mobile,
          email: body.email,
          city: body.city,
          country: body.country,
          message: body.message || body.body,
          product: body.product,
          product_title: body.product_title,
          page_url: body.page_url,
          action: body.type || body.action,
          context: body.context,
          lead_type: body.lead_type,
        });
        if (result.leadId) {
          this.logger.log(`Shopify webhook (deprecated): lead id=${result.leadId}`);
        }
      } catch (e: any) {
        this.logger.error(`Shopify webhook processing failed: ${e?.message}`, e?.stack);
      }
    });

    return { ok: true };
  }

  // ─── Webhook health — manager visibility ─────────────────────────────────
  @Get('health')
  @RequirePermission('crm.analytics.team')
  getWebhookHealth() {
    const SOURCES = ['META', 'GOOGLE', 'INDIAMART', 'SHOPIFY'] as const;
    const now = Date.now();

    return SOURCES.reduce<Record<string, { last_received_at: string | null; minutes_ago: number | null; healthy: boolean }>>(
      (acc, src) => {
        const ts = this.lastReceived[src];
        const minutesAgo = ts ? Math.floor((now - ts.getTime()) / 60_000) : null;
        acc[src] = {
          last_received_at: ts ? ts.toISOString() : null,
          minutes_ago: minutesAgo,
          // healthy = received at least once AND within the threshold.
          // null (never received this session) is shown as unknown, not unhealthy.
          healthy: minutesAgo !== null && minutesAgo < HEALTHY_THRESHOLD_HOURS * 60,
        };
        return acc;
      },
      {},
    );
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

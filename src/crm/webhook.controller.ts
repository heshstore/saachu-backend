import {
  Controller, Post, Get, Body, Headers, Query, Res, HttpCode,
} from '@nestjs/common';
import { Response } from 'express';
import * as crypto from 'crypto';
import { Public } from '../auth/public.decorator';
import { LeadService } from './lead.service';
import { normalizeIndiaMart } from './normalizers/indiamart.normalizer';
import { normalizeMetaLead } from './normalizers/meta.normalizer';
import { normalizeShopify } from './normalizers/shopify.normalizer';
import { appConfig } from '../config/config';
import axios from 'axios';

type MetaLeadResponse = {
  field_data?: any[];
};

@Controller('leads/webhook')
export class WebhookController {
  constructor(private readonly leadService: LeadService) {}

  // ─── IndiaMart ───────────────────────────────────────────────────────────
  @Public()
  @Post('indiamart')
  @HttpCode(200)
  async indiaMart(@Body() body: any, @Headers('x-indiamart-secret') secret: string) {
    if (appConfig.indiaMartSecretKey && secret !== appConfig.indiaMartSecretKey) return { ok: true };

    setImmediate(async () => {
      try {
        const dto = normalizeIndiaMart(body);
        if (!dto.phone) return;
        await this.leadService.create(dto as any, { id: null, role: 'Admin' });
      } catch (e) {
        console.error('[Webhook/IndiaMart]', e?.message);
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
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // ─── Meta — lead event ───────────────────────────────────────────────────
  @Public()
  @Post('meta')
  @HttpCode(200)
  metaLead(@Body() body: any, @Headers('x-hub-signature-256') sig: string) {
    // Verify HMAC signature
    if (appConfig.metaAccessToken) {
      const expected =
        'sha256=' +
        crypto
          .createHmac('sha256', appConfig.metaAccessToken)
          .update(JSON.stringify(body))
          .digest('hex');
      if (sig !== expected) return { ok: true };
    }

    // Respond 200 immediately, process async
    setImmediate(async () => {
      try {
        const entries = body?.entry ?? [];
        for (const entry of entries) {
          for (const change of entry?.changes ?? []) {
            const val = change?.value;
            if (!val?.leadgen_id) continue;

            // Fetch full lead data from Meta Graph API
            const leadgenId = String(val.leadgen_id);
            const existing = await this.leadService.findByExternalId(leadgenId);
            if (existing) continue;

            let fields: any[] = [];
            try {
              const resp = await axios.get<MetaLeadResponse>(
                `https://graph.facebook.com/v19.0/${leadgenId}`,
                { params: { access_token: appConfig.metaAccessToken } },
              );
              fields = resp.data?.field_data ?? [];
            } catch (err) {
              console.error('[Webhook/Meta] Graph API error:', err?.message);
              fields = [];
            }

            const dto = normalizeMetaLead(fields, leadgenId);
            if (!dto.phone) continue;
            await this.leadService.create(dto as any, { id: null, role: 'Admin' });
          }
        }
      } catch (e) {
        console.error('[Webhook/Meta]', e?.message);
      }
    });

    return { ok: true };
  }

  // ─── Shopify contact form ─────────────────────────────────────────────────
  @Public()
  @Post('shopify')
  @HttpCode(200)
  shopify(@Body() body: any, @Headers('x-shopify-hmac-sha256') sig: string) {
    setImmediate(async () => {
      try {
        const dto = normalizeShopify(body);
        if (!dto.phone && !dto.email) return;
        await this.leadService.create(dto as any, { id: null, role: 'Admin' });
      } catch (e) {
        console.error('[Webhook/Shopify]', e?.message);
      }
    });

    return { ok: true };
  }
}

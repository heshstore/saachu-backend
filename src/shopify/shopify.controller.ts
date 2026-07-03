import { Controller, Get, Post, Param, Logger } from '@nestjs/common';
import {
  ShopifyService,
  getSyncStatus,
  isShopifyConfigured,
} from './shopify.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  @Get('products')
  @RequirePermission('item.view')
  getProducts() {
    return this.shopifyService.getProducts();
  }

  /** Non-blocking fire-and-forget — returns immediately, sync runs in background.
   *  Frontend should poll GET /shopify/sync-status for progress. */
  @Post('sync/start')
  @RequirePermission('item.shopify_sync')
  startSync() {
    if (!isShopifyConfigured()) {
      this.logger.warn(
        '[SHOPIFY] startSync called but Shopify env vars are not configured',
      );
      return {
        started: false,
        reason:
          'Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN on the server',
      };
    }
    const current = getSyncStatus();
    if (current.status === 'running') {
      this.logger.warn(
        '[SHOPIFY] startSync called but sync already running — attaching caller to existing run',
      );
      return {
        started: false,
        reason: 'Sync already in progress',
        status: current,
      };
    }
    this.logger.log(
      '[SHOPIFY] Manual sync started via POST /shopify/sync/start',
    );
    // Fire without awaiting — runs in background, progress visible via /sync-status
    void this.shopifyService
      .syncProducts({ trigger: 'manual' })
      .catch((err) => {
        this.logger.error('[SHOPIFY] Background sync error:', err?.message);
      });
    return { started: true };
  }

  @Get('sync-status')
  getStatus() {
    return getSyncStatus();
  }

  /** Blocking sync — kept for internal/programmatic use (e.g. scripts, health checks).
   *  Do NOT call from frontend — will time out for large catalogs. */
  @Get('sync-products')
  @RequirePermission('item.shopify_sync')
  async syncProductsBlocking() {
    this.logger.log(
      '[SHOPIFY] Blocking sync triggered via GET /shopify/sync-products',
    );
    try {
      return await this.shopifyService.syncProducts();
    } catch (error: any) {
      this.logger.error('[SHOPIFY] Blocking sync error:', error?.message);
      return {
        fetched: 0,
        variants: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        skippedReasons: {},
        errors: 1,
        durationMs: 0,
        error: error?.message ?? 'Sync failed',
      };
    }
  }

  @Get('sync')
  @RequirePermission('item.shopify_sync')
  syncAlias() {
    return this.syncProductsBlocking();
  }

  /** Backfill description/tags/vendor/productType/handle on all existing catalog rows.
   *  Fetches all active Shopify products and patches ONLY the 5 knowledge fields.
   *  Safe to run multiple times. Does not touch prices, names, or SKUs. */
  @Post('backfill-knowledge')
  @RequirePermission('item.shopify_sync')
  async backfillKnowledge() {
    if (!isShopifyConfigured()) {
      return { started: false, reason: 'Shopify not configured' };
    }
    this.logger.log(
      '[SHOPIFY] Knowledge backfill started via POST /shopify/backfill-knowledge',
    );
    return this.shopifyService.backfillKnowledgeFields();
  }

  /** Knowledge coverage report — shows how many catalog items have description/tags/vendor/productType.
   *  Use to measure Promotion AI input quality before and after backfill. */
  @Get('knowledge-report')
  @RequirePermission('item.view')
  knowledgeReport() {
    return this.shopifyService.getKnowledgeReport();
  }

  @Get(':sku')
  @RequirePermission('item.view')
  getItem(@Param('sku') sku: string) {
    return this.shopifyService.getItemBySku(sku);
  }
}

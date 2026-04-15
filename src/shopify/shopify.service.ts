import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ItemsService } from '../items/items.service';
import { Item } from '../items/entities/item.entity';

// Module-level progress object — reset on server restart only
let syncStatus = {
  total: 0,
  processed: 0,
  skipped: 0,
  status: 'idle' as 'idle' | 'running' | 'done',
  phase: 'idle' as 'idle' | 'fetching' | 'saving' | 'done',
  lastError: '',
};

export function getSyncStatus() {
  return syncStatus;
}

@Injectable()
export class ShopifyService {

  constructor(
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
    @InjectRepository(Item)
    private itemsRepository: Repository<Item>,
    private readonly itemsService: ItemsService,
  ) {}

  // ── Fetch all active products from Shopify (paginated) ──────────────────
  async getProducts(): Promise<any[]> {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!store || !token) {
      throw new Error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env');
    }

    let allProducts: any[] = [];
    let since_id: string | undefined;

    while (true) {
      const url = since_id
        ? `https://${store}/admin/api/2023-10/products.json?limit=250&status=active&since_id=${since_id}`
        : `https://${store}/admin/api/2023-10/products.json?limit=250&status=active`;

      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': token },
        timeout: 30000,
      });

      const products: any[] = (response.data as any)?.products || [];
      if (products.length === 0) break;

      allProducts.push(...products);
      since_id = products[products.length - 1].id;
    }

    return allProducts;
  }

  /**
   * Split "Acrylic Counter Tray FOURBELS - F3" → { cleanTitle: "Acrylic Counter Tray FOURBELS", productSku: "F3" }
   * Splits at the LAST occurrence of " - ".  If no " - " exists, cleanTitle = full title, productSku = "".
   */
  private parseProductTitle(raw: string): { cleanTitle: string; productSku: string } {
    const idx = raw.lastIndexOf(' - ');
    if (idx === -1) return { cleanTitle: raw.trim(), productSku: '' };
    return {
      cleanTitle: raw.slice(0, idx).trim(),
      productSku: raw.slice(idx + 3).trim(),
    };
  }

  // ── Flatten products → variants, resolving the best available image ──────
  private flattenToVariants(products: any[]): Array<{
    shopifyProductId: string;
    variantId: string;
    title: string;
    sku: string;
    price: number;
    image: string;
  }> {
    return products.flatMap((p: any) => {
      // Build a map of imageId → src for variant-specific images
      const imageMap: Record<string, string> = {};
      for (const img of p.images || []) {
        if (img.id && img.src) imageMap[img.id] = img.src;
      }

      const productImage: string = p.image?.src || '';
      // Use the clean title (strip " - SKU" suffix from Shopify product titles)
      const { cleanTitle } = this.parseProductTitle((p.title || '').trim());

      return (p.variants || []).map((v: any) => {
        // Prefer variant-specific image, then product main image
        const variantImage: string =
          (v.image_id && imageMap[v.image_id]) ? imageMap[v.image_id] : productImage;

        return {
          shopifyProductId: String(p.id),
          variantId: String(v.id),       // stable Shopify variant ID — never changes
          title: cleanTitle,
          sku: (v.sku || '').trim(),
          price: Number(v.price || 0),
          image: variantImage,
        };
      });
    });
  }

  // ── Main sync ─────────────────────────────────────────────────────────────
  async syncProducts() {
    // ✅ Mark running IMMEDIATELY — before any async work
    syncStatus = { total: 0, processed: 0, skipped: 0, status: 'running', phase: 'fetching', lastError: '' };

    try {
      // Fetch from Shopify (can take 10-15 s for 660 products)
      const rawProducts = await this.getProducts();
      const variants = this.flattenToVariants(rawProducts);

      // Pre-count valid variants so the progress bar knows the total
      const validVariants = variants.filter(
        (v) => v.sku && v.title && v.price > 0 && v.image,
      );

      syncStatus.total = validVariants.length;
      syncStatus.phase = 'saving';

      let savedCount = 0;
      let skippedCount = 0;

      for (const v of variants) {
        // ── Skip conditions ──────────────────────────────────────────────
        if (!v.sku) {
          console.log(`⛔ SKIP (no SKU): ${v.title}`);
          skippedCount++;
          continue;
        }
        if (!v.title) {
          console.log(`⛔ SKIP (no title): ${v.sku}`);
          skippedCount++;
          continue;
        }
        if (v.price <= 0) {
          console.log(`⛔ SKIP (no price): ${v.sku}`);
          skippedCount++;
          continue;
        }
        if (!v.image) {
          console.log(`⛔ SKIP (no image): ${v.sku}`);
          skippedCount++;
          continue;
        }

        // ── Upsert ───────────────────────────────────────────────────────
        // 1. Match by Shopify variant ID  → handles SKU / title / price edits
        // 2. Fall back to SKU match        → handles pre-existing records without variantId
        // Matching by variant ID prevents orphaned old records when a SKU is renamed.
        let existing = await this.itemsRepository.findOne({
          where: { shopifyVariantId: v.variantId },
        });

        if (!existing && v.sku) {
          existing = await this.itemsRepository.findOne({ where: { sku: v.sku } });
        }

        if (existing) {
          // Detect if the SKU changed in Shopify
          const skuChanged = existing.sku !== v.sku;
          if (skuChanged) {
            console.log(`🔄 SKU renamed: "${existing.sku}" → "${v.sku}" (variantId ${v.variantId})`);
          }
          await this.itemsRepository.update(
            { id: existing.id },
            {
              itemName: v.title,
              sku: v.sku,                  // update in case SKU was renamed in Shopify
              sellingPrice: v.price,
              retail_price: v.price,
              image: v.image,
              source: 'shopify',
              shopifyVariantId: v.variantId,  // stamp the variant ID so future syncs match correctly
            },
          );
        } else {
          await this.itemsRepository.save({
            itemName: v.title,
            sku: v.sku,
            sellingPrice: v.price,
            retail_price: v.price,
            image: v.image,
            hsnCode: '',
            gst: 0,
            costPrice: 0,
            unit: 'Nos',
            source: 'shopify',
            shopifyVariantId: v.variantId,
          });
        }

        savedCount++;
        syncStatus.processed = savedCount;
      }

      skippedCount += (variants.length - validVariants.length - (skippedCount - 0));
      syncStatus.skipped = variants.length - savedCount - validVariants.length + savedCount;

      const finalSkipped = variants.length - savedCount;
      syncStatus.status = 'done';
      syncStatus.phase = 'done';
      syncStatus.processed = savedCount;
      syncStatus.skipped = finalSkipped;

      console.log(`✅ Sync complete — saved: ${savedCount}, skipped: ${finalSkipped}`);

      return { count: savedCount, skipped: finalSkipped };

    } catch (error: any) {
      console.error('❌ Sync error:', error.message);
      syncStatus.status = 'done';
      syncStatus.phase = 'done';
      syncStatus.lastError = error.message;
      return { count: 0, error: error.message };
    }
  }

  // ── Get single item by SKU (used by order flow) ──────────────────────────
  async getItemBySku(sku: string) {
    const normalize = (str: any) =>
      (str || '').toString().toLowerCase().replace(/\s+/g, '');

    const items = await this.itemsRepository.find();
    const found = items.find(
      (i) =>
        normalize(i.sku) === normalize(sku) ||
        normalize(i.sku).includes(normalize(sku)),
    );

    if (!found) return null;

    return {
      sku: found.sku,
      itemName: found.itemName,
      price: Number(found.sellingPrice),
      image: found.image || null,
      gst: Number(found.gst) || 0,
    };
  }
}

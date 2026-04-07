import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class ShopifyService {

  constructor(
    @InjectRepository(Product)
    private productRepo: Repository<Product>,
  ) {}

  // ✅ GET PRODUCTS FROM SHOPIFY
  async getProducts() {
    const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250`;

    try {
      console.log("SHOP:", process.env.SHOPIFY_STORE);
      console.log("TOKEN:", process.env.SHOPIFY_ACCESS_TOKEN?.slice(0, 10));
      console.log("URL:", url);

      const response = await axios.get(url, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      });

      const products = (response.data as any).products;

      return products.flatMap((p: any) => {
        // ❌ Skip product if no image
        if (!p.image?.src) return [];

        return p.variants
          .filter((v: any) => {
            return (
              v.sku &&
              v.sku.trim() !== "" &&
              Number(v.price) > 0
            );
          })
          .map((v: any) => ({
            shopifyId: String(p.id),
            title: p.title,
            image: p.image.src,
            sku: v.sku.trim(),
            price: Number(v.price),
          }));
      });

    } catch (error) {
      console.error("SHOPIFY ERROR 👉", error.response?.data || error.message);
      throw error;
    }
  }

  // ✅ SYNC PRODUCTS (CREATE + UPDATE + DISABLE)
  async syncProducts() {
    const shopifyProducts = await this.getProducts();

    const existing = await this.productRepo.find();
    const existingMap = new Map(existing.map(i => [i.sku, i]));
    const seenSkus = new Set();

    for (const p of shopifyProducts) {

      // ✅ safety checks
      if (!p.sku || !p.price || !p.image || !p.shopifyId) continue;

      seenSkus.add(p.sku);

      const existingItem = existingMap.get(p.sku);

      if (existingItem) {
        // ✅ UPDATE EXISTING
        await this.productRepo.update(existingItem.id, {
          title: p.title,
          price: p.price,
          image: p.image,
          shopifyId: p.shopifyId,
          isActive: true,
        });
      } else {
        // ✅ CREATE NEW
        await this.productRepo.save({
          shopifyId: p.shopifyId,
          title: p.title,
          sku: p.sku,
          price: p.price,
          image: p.image,
          inventory: 0,
          isActive: true,
        });
      }
    }

    // ✅ DISABLE REMOVED PRODUCTS
    for (const item of existing) {
      if (!seenSkus.has(item.sku)) {
        await this.productRepo.update(item.id, {
          isActive: false,
        });
      }
    }

    return {
      message: 'Shopify Sync Complete ✅',
      count: shopifyProducts.length,
    };
  }

  // ✅ GET ITEM BY SKU (FOR ORDER USE)
  async getItemBySku(sku: string) {
    const normalize = (str: any) =>
      (str || "").toString().toLowerCase().replace(/\s+/g, "");

    const items = await this.productRepo.find({
      where: { isActive: true },
    });

    const found = items.find(
      i =>
        normalize(i.sku) === normalize(sku) ||
        normalize(i.sku).includes(normalize(sku))
    );

    if (!found) return null;

    return {
      sku: found.sku,
      itemName: found.title,
      price: Number(found.price),
      image: found.image,
      gst: 0,
    };
  }
}
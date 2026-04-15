import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In } from 'typeorm';

import { Item } from './entities/item.entity';

// 🚀 STRICT MODE — FIX ITEM SERVICE
function safeNumber(value: any): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

@Injectable()
export class ItemsService {
  constructor(
    @InjectRepository(Item)
    private repo: Repository<Item>,
  ) {}

  create(data: any) {
    console.log("CREATE DATA:", data);

    return this.repo.save({
      itemName: data.itemName,
      sku: data.sku,
      hsnCode: data.hsnCode || '',
      gst: safeNumber(data.gst),
      costPrice: safeNumber(data.costPrice),
      sellingPrice: safeNumber(data.sellingPrice),
      source: data.source || 'service', // <-- ADDED THIS LINE
    });
  }

  async createBulk(dataArray: any[]) {
    // 🔥 delete existing SKUs first
    const skus = dataArray.map(d => d.sku);

    await this.repo.delete({ sku: In(skus) });

    // 🔥 save all at once
    const cleanData = dataArray.map(data => ({
      itemName: data.itemName,
      sku: data.sku,
      hsnCode: data.hsnCode || '',
      gst: safeNumber(data.gst),
      costPrice: safeNumber(data.costPrice),
      sellingPrice: safeNumber(data.sellingPrice),
      retail_price: safeNumber(data.retail_price ?? data.sellingPrice),
      wholesale_price: safeNumber(data.wholesale_price ?? 0),
      image: data.image || null,
      unit: data.unit || 'Nos',
      source: data.source || 'service',
    }));

    return this.repo.save(cleanData);
  }

  findAll() {
    return this.repo.find({ order: { itemName: 'ASC' } });
  }

  /** Only items with HSN Code and Cost Price filled — safe to use in orders */
  findMaster() {
    return this.repo
      .createQueryBuilder('item')
      .where("item.hsnCode IS NOT NULL AND item.hsnCode != ''")
      .andWhere('item.costPrice > 0')
      .orderBy('item.itemName', 'ASC')
      .getMany();
  }

  findOne(id: number) {
    return this.repo.findOneBy({ id });
  }

  async update(id: number, data: any) {
    // Optional: could sanitize here too if numeric fields might appear,
    // but main use is POST, not PUT/PATCH in current pattern.
    await this.repo.update(id, data);
    return { message: 'Updated' };
  }

  async remove(id: number) {
    await this.repo.delete(id);
    return { message: 'Deleted' };
  }

  async searchItems(q: string) {
    if (!q) return [];

    return this.repo
      .createQueryBuilder('item')
      .where(
        "(item.itemName ILIKE :q OR item.sku ILIKE :q)",
        { q: `%${q}%` },
      )
      .andWhere("item.hsnCode IS NOT NULL AND item.hsnCode != ''")
      .andWhere('item.costPrice > 0')
      .orderBy('item.sku', 'ASC')
      .take(15)
      .getMany();
  }

  // 🚀 STRICT MODE — FIX removeBySku
  async removeBySku(sku: string) {
    if (!sku) return;
    return this.repo.delete({ sku });
  }
}
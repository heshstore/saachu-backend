import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ServiceItem } from './entities/service-item.entity';

function safeNumber(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

@Injectable()
export class ServiceItemsService {
  private readonly logger = new Logger(ServiceItemsService.name);

  constructor(
    @InjectRepository(ServiceItem)
    private readonly repo: Repository<ServiceItem>,
    private readonly dataSource: DataSource,
  ) {}

  private async nextItemCode(): Promise<string> {
    const result = await this.dataSource.query(
      `SELECT nextval('svc_item_code_seq') AS seq`,
    );
    const seq = Number(result[0]?.seq ?? 1);
    return `SVC-${String(seq).padStart(6, '0')}`;
  }

  findAll() {
    return this.repo.find({ where: { isActive: true }, order: { itemName: 'ASC' } });
  }

  findAllIncludingInactive() {
    return this.repo.find({ order: { itemName: 'ASC' } });
  }

  findById(id: number) {
    return this.repo.findOneBy({ id });
  }

  findBySku(sku: string) {
    return this.repo.findOneBy({ sku });
  }

  async create(data: any) {
    const itemCode = await this.nextItemCode();
    return this.repo.save({
      itemCode,
      itemName:     data.itemName,
      sku:          data.sku,
      hsnCode:      data.hsnCode || '',
      gst:          safeNumber(data.gst),
      costPrice:    safeNumber(data.costPrice),
      sellingPrice: safeNumber(data.sellingPrice),
      unit:         data.unit || 'Nos',
      source:       'MANUAL',
      isActive:     true,
    });
  }

  async update(id: number, data: any) {
    const update: Partial<ServiceItem> = {};
    if (data.itemName  !== undefined) update.itemName     = data.itemName;
    if (data.sku       !== undefined) update.sku          = data.sku;
    if (data.hsnCode   !== undefined) update.hsnCode      = data.hsnCode;
    if (data.gst       !== undefined) update.gst          = safeNumber(data.gst);
    if (data.costPrice !== undefined) update.costPrice     = safeNumber(data.costPrice);
    if (data.sellingPrice !== undefined) update.sellingPrice = safeNumber(data.sellingPrice);
    if (data.unit      !== undefined) update.unit         = data.unit;
    await this.repo.update(id, update);
    return this.repo.findOneBy({ id });
  }

  async softDelete(id: number) {
    await this.repo.update(id, { isActive: false });
    return { message: 'Item deactivated' };
  }

  async hardDeleteBySku(sku: string) {
    return this.repo.delete({ sku });
  }
}

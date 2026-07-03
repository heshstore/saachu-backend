import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ServiceItem } from './entities/service-item.entity';
import { clearItemsCache } from '../items/items.service';

const ALLOWED_GST = [5, 18];

function safeNumber(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function validateGst(v: any): void {
  if (v === undefined || v === null || v === '') return;
  const n = Number(v);
  if (!ALLOWED_GST.includes(n)) {
    throw new BadRequestException(
      `Invalid GST rate ${v}. Allowed values: ${ALLOWED_GST.join(', ')}%`,
    );
  }
}

/** Automation defaults: category type → production/purchase flags */
const CATEGORY_DEFAULTS: Record<
  string,
  { requiresProduction: boolean; requiresPurchase: boolean }
> = {
  TRADING: { requiresProduction: false, requiresPurchase: true },
  MANUFACTURING: { requiresProduction: true, requiresPurchase: true },
  SERVICE: { requiresProduction: false, requiresPurchase: false },
};

function applyAutomationDefaults(
  categoryType: string | undefined,
  explicitProduction: any,
  explicitPurchase: any,
): { requiresProduction: boolean; requiresPurchase: boolean } {
  const defaults =
    CATEGORY_DEFAULTS[categoryType ?? 'TRADING'] ??
    CATEGORY_DEFAULTS['TRADING'];
  return {
    requiresProduction:
      explicitProduction !== undefined
        ? Boolean(explicitProduction)
        : defaults.requiresProduction,
    requiresPurchase:
      explicitPurchase !== undefined
        ? Boolean(explicitPurchase)
        : defaults.requiresPurchase,
  };
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
    return this.repo.find({
      where: { isActive: true },
      order: { itemName: 'ASC' },
    });
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
    validateGst(data.gst);
    const itemCode = await this.nextItemCode();
    const categoryType = data.mainCategoryType || 'TRADING';
    const { requiresProduction, requiresPurchase } = applyAutomationDefaults(
      categoryType,
      data.requiresProduction,
      data.requiresPurchase,
    );
    const saved = await this.repo.save({
      itemCode,
      itemName: data.itemName,
      sku: data.sku,
      hsnCode: data.hsnCode || '',
      gst: safeNumber(data.gst),
      costPrice: safeNumber(data.costPrice),
      sellingPrice: safeNumber(data.sellingPrice),
      unit: data.unit || 'Nos',
      source: 'MANUAL',
      isActive: true,
      mainCategoryType: categoryType,
      serviceSubtype: data.serviceSubtype || null,
      boqStatus: data.boqStatus || 'NOT_CREATED',
      requiresProduction,
      requiresPurchase,
      stockTrackingType: data.stockTrackingType || 'PCS',
      isRawMaterial: Boolean(data.isRawMaterial),
      imageUrl: data.imageUrl || null,
    });
    clearItemsCache();
    return saved;
  }

  async update(id: number, data: any) {
    validateGst(data.gst);
    const update: Partial<ServiceItem> = {};
    if (data.itemName !== undefined) update.itemName = data.itemName;
    if (data.sku !== undefined) update.sku = data.sku;
    if (data.hsnCode !== undefined) update.hsnCode = data.hsnCode;
    if (data.gst !== undefined) update.gst = safeNumber(data.gst);
    if (data.costPrice !== undefined)
      update.costPrice = safeNumber(data.costPrice);
    if (data.sellingPrice !== undefined)
      update.sellingPrice = safeNumber(data.sellingPrice);
    if (data.unit !== undefined) update.unit = data.unit;

    // Classification fields
    if (data.mainCategoryType !== undefined)
      update.mainCategoryType = data.mainCategoryType;
    if (data.serviceSubtype !== undefined)
      update.serviceSubtype = data.serviceSubtype || null;
    if (data.boqStatus !== undefined) update.boqStatus = data.boqStatus;
    if (data.stockTrackingType !== undefined)
      update.stockTrackingType = data.stockTrackingType;
    if (data.isRawMaterial !== undefined)
      update.isRawMaterial = Boolean(data.isRawMaterial);
    if (data.imageUrl !== undefined) update.imageUrl = data.imageUrl || null;

    // If category type changes, recompute automation defaults unless explicitly overridden
    if (data.mainCategoryType !== undefined) {
      const { requiresProduction, requiresPurchase } = applyAutomationDefaults(
        data.mainCategoryType,
        data.requiresProduction,
        data.requiresPurchase,
      );
      update.requiresProduction = requiresProduction;
      update.requiresPurchase = requiresPurchase;
    } else {
      if (data.requiresProduction !== undefined)
        update.requiresProduction = Boolean(data.requiresProduction);
      if (data.requiresPurchase !== undefined)
        update.requiresPurchase = Boolean(data.requiresPurchase);
    }

    await this.repo.update(id, update);
    clearItemsCache();
    return this.repo.findOneBy({ id });
  }

  async softDelete(id: number) {
    await this.repo.update(id, { isActive: false });
    clearItemsCache();
    return { message: 'Item deactivated' };
  }

  async hardDeleteBySku(sku: string) {
    clearItemsCache();
    return this.repo.delete({ sku });
  }
}

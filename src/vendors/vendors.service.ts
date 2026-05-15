import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vendor } from './entities/vendor.entity';
import { VendorItemMapping } from './entities/vendor-item-mapping.entity';

@Injectable()
export class VendorsService {
  constructor(
    @InjectRepository(Vendor)
    private readonly vendorRepo: Repository<Vendor>,
    @InjectRepository(VendorItemMapping)
    private readonly mapRepo: Repository<VendorItemMapping>,
  ) {}

  async findAll(q?: {
    search?: string;
    active?: string;
  }): Promise<Vendor[]> {
    const qb = this.vendorRepo.createQueryBuilder('v').orderBy('v.vendor_name', 'ASC');
    if (q?.search?.trim()) {
      const s = `%${q.search.trim()}%`;
      qb.andWhere(
        '(v.vendor_name ILIKE :s OR v.vendor_code ILIKE :s OR v.phone ILIKE :s OR v.email ILIKE :s OR v.gst_number ILIKE :s)',
        { s },
      );
    }
    if (q?.active === 'true') {
      qb.andWhere('v.active = true');
    } else if (q?.active === 'false') {
      qb.andWhere('v.active = false');
    }
    return qb.getMany();
  }

  async findOne(id: number): Promise<Vendor> {
    const v = await this.vendorRepo.findOneBy({ id });
    if (!v) throw new NotFoundException(`Vendor ${id} not found`);
    return v;
  }

  async create(data: any): Promise<Vendor> {
    const code = (data.vendorCode ?? data.vendor_code ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('vendorCode is required');
    if (!(data.vendorName ?? data.vendor_name)?.trim()) {
      throw new BadRequestException('vendorName is required');
    }
    const v = this.vendorRepo.create({
      vendorCode:     code,
      vendorName:     (data.vendorName ?? data.vendor_name).trim(),
      contactPerson:  data.contactPerson ?? data.contact_person ?? null,
      phone:          data.phone ?? null,
      email:          data.email ?? null,
      gstNumber:      data.gstNumber ?? data.gst_number ?? null,
      address:        data.address ?? null,
      city:           data.city ?? null,
      state:          data.state ?? null,
      pincode:        data.pincode ?? null,
      paymentTerms:   data.paymentTerms ?? data.payment_terms ?? null,
      active:         data.active !== false,
      remarks:        data.remarks ?? null,
    });
    return this.vendorRepo.save(v);
  }

  async update(id: number, data: any): Promise<Vendor> {
    const v = await this.findOne(id);
    if (data.vendorCode !== undefined || data.vendor_code !== undefined) {
      v.vendorCode = String(data.vendorCode ?? data.vendor_code).trim().toUpperCase();
    }
    if (data.vendorName !== undefined || data.vendor_name !== undefined) {
      v.vendorName = String(data.vendorName ?? data.vendor_name).trim();
    }
    if (data.contactPerson !== undefined || data.contact_person !== undefined) {
      v.contactPerson = data.contactPerson ?? data.contact_person ?? null;
    }
    if (data.phone !== undefined) v.phone = data.phone ?? null;
    if (data.email !== undefined) v.email = data.email ?? null;
    if (data.gstNumber !== undefined || data.gst_number !== undefined) {
      v.gstNumber = data.gstNumber ?? data.gst_number ?? null;
    }
    if (data.address !== undefined) v.address = data.address ?? null;
    if (data.city !== undefined) v.city = data.city ?? null;
    if (data.state !== undefined) v.state = data.state ?? null;
    if (data.pincode !== undefined) v.pincode = data.pincode ?? null;
    if (data.paymentTerms !== undefined || data.payment_terms !== undefined) {
      v.paymentTerms = data.paymentTerms ?? data.payment_terms ?? null;
    }
    if (data.active !== undefined) v.active = Boolean(data.active);
    if (data.remarks !== undefined) v.remarks = data.remarks ?? null;
    return this.vendorRepo.save(v);
  }

  // ── Vendor ↔ item mappings ─────────────────────────────────────────────────

  async findMappingsForItem(itemId: number, itemSource = 'SERVICE'): Promise<any[]> {
    return this.mapRepo.find({
      where: { itemId, itemSource },
      relations: ['vendor'],
      order:    { preferredVendor: 'DESC', id: 'ASC' },
    });
  }

  async createMapping(data: any): Promise<VendorItemMapping> {
    if (!data.vendorId && !data.vendor_id) throw new BadRequestException('vendorId is required');
    if (!data.itemId && !data.item_id) throw new BadRequestException('itemId is required');
    const itemSource = (data.itemSource ?? data.item_source ?? 'SERVICE').toUpperCase();
    if (!['SERVICE', 'SHOPIFY'].includes(itemSource)) {
      throw new BadRequestException('itemSource must be SERVICE or SHOPIFY');
    }
    const m = this.mapRepo.create({
      vendorId:         Number(data.vendorId ?? data.vendor_id),
      itemId:           Number(data.itemId ?? data.item_id),
      itemSource,
      vendorSku:        data.vendorSku ?? data.vendor_sku ?? null,
      purchaseRate:     Number(data.purchaseRate ?? data.purchase_rate ?? 0),
      minimumOrderQty:  Number(data.minimumOrderQty ?? data.minimum_order_qty ?? 0),
      leadTimeDays:     Number(data.leadTimeDays ?? data.lead_time_days ?? 0),
      preferredVendor:  Boolean(data.preferredVendor ?? data.preferred_vendor),
      lastPurchaseRate: data.lastPurchaseRate != null || data.last_purchase_rate != null
        ? Number(data.lastPurchaseRate ?? data.last_purchase_rate)
        : null,
      remarks:          data.remarks ?? null,
    });
    return this.mapRepo.save(m);
  }

  async updateMapping(id: number, data: any): Promise<VendorItemMapping> {
    const m = await this.mapRepo.findOneBy({ id });
    if (!m) throw new NotFoundException(`Mapping ${id} not found`);
    if (data.vendorSku !== undefined || data.vendor_sku !== undefined) {
      m.vendorSku = data.vendorSku ?? data.vendor_sku ?? null;
    }
    if (data.purchaseRate !== undefined || data.purchase_rate !== undefined) {
      m.purchaseRate = Number(data.purchaseRate ?? data.purchase_rate ?? 0);
    }
    if (data.minimumOrderQty !== undefined || data.minimum_order_qty !== undefined) {
      m.minimumOrderQty = Number(data.minimumOrderQty ?? data.minimum_order_qty ?? 0);
    }
    if (data.leadTimeDays !== undefined || data.lead_time_days !== undefined) {
      m.leadTimeDays = Number(data.leadTimeDays ?? data.lead_time_days ?? 0);
    }
    if (data.preferredVendor !== undefined || data.preferred_vendor !== undefined) {
      m.preferredVendor = Boolean(data.preferredVendor ?? data.preferred_vendor);
    }
    if (data.lastPurchaseRate !== undefined || data.last_purchase_rate !== undefined) {
      m.lastPurchaseRate = data.lastPurchaseRate ?? data.last_purchase_rate ?? null;
    }
    if (data.remarks !== undefined) m.remarks = data.remarks ?? null;
    return this.mapRepo.save(m);
  }

  async deleteMapping(id: number): Promise<void> {
    const m = await this.mapRepo.findOneBy({ id });
    if (!m) throw new NotFoundException(`Mapping ${id} not found`);
    await this.mapRepo.remove(m);
  }

  /** Best mapping for vendor + item (preferred first, else lowest rate) */
  async resolveMapping(vendorId: number, itemId: number, itemSource: string): Promise<VendorItemMapping | null> {
    const rows = await this.mapRepo.find({
      where: { vendorId, itemId, itemSource },
      order: { preferredVendor: 'DESC', purchaseRate: 'ASC' },
    });
    return rows[0] ?? null;
  }
}

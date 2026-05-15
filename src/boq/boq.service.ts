import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ManufacturingBoq } from './entities/manufacturing-boq.entity';
import { ManufacturingBoqItem } from './entities/manufacturing-boq-item.entity';

@Injectable()
export class BoqService {
  constructor(
    @InjectRepository(ManufacturingBoq)
    private readonly boqRepo: Repository<ManufacturingBoq>,
    @InjectRepository(ManufacturingBoqItem)
    private readonly lineRepo: Repository<ManufacturingBoqItem>,
  ) {}

  /** GET /boq/item/:itemId — returns all BOQs with nested lines */
  findByItem(itemId: number): Promise<ManufacturingBoq[]> {
    return this.boqRepo.find({
      where: { itemId },
      order: { version: 'DESC' },
    });
  }

  /** POST /boq — create BOQ header */
  async createBoq(data: any): Promise<ManufacturingBoq> {
    const existing = await this.boqRepo.find({ where: { itemId: data.itemId } });
    const version  = existing.length + 1;

    const boq = this.boqRepo.create({
      itemId:    Number(data.itemId),
      version,
      status:    'DRAFT',
      notes:     data.notes ?? null,
      createdBy: data.createdBy ?? null,
    });
    return this.boqRepo.save(boq);
  }

  /** PATCH /boq/:id — update header (status, notes) */
  async updateBoq(id: number, data: any): Promise<ManufacturingBoq> {
    const boq = await this.boqRepo.findOneBy({ id });
    if (!boq) throw new NotFoundException(`BOQ ${id} not found`);

    if (data.status !== undefined) {
      const valid = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
      if (!valid.includes(data.status)) {
        throw new BadRequestException(`status must be one of: ${valid.join(', ')}`);
      }
      boq.status = data.status;
    }
    if (data.notes !== undefined) boq.notes = data.notes ?? null;

    return this.boqRepo.save(boq);
  }

  /** POST /boq/:boqId/lines — add a line */
  async addLine(boqId: number, data: any): Promise<ManufacturingBoqItem> {
    const boq = await this.boqRepo.findOneBy({ id: boqId });
    if (!boq) throw new NotFoundException(`BOQ ${boqId} not found`);

    const qty = Number(data.qtyPerUnit);
    if (!qty || qty <= 0) {
      throw new BadRequestException('qtyPerUnit must be > 0');
    }
    if (!data.rawMaterialItemId) {
      throw new BadRequestException('rawMaterialItemId is required');
    }
    if (!data.departmentId) {
      throw new BadRequestException('departmentId is required');
    }
    if (!data.consumptionType) {
      throw new BadRequestException('consumptionType is required');
    }

    const line = this.lineRepo.create({
      boqId,
      rawMaterialItemId: Number(data.rawMaterialItemId),
      departmentId:      Number(data.departmentId),
      consumptionType:   data.consumptionType,
      qtyPerUnit:        qty,
      wastagePercent:    Number(data.wastagePercent ?? 0),
      width:             data.width    != null ? Number(data.width)    : null,
      height:            data.height   != null ? Number(data.height)   : null,
      sheetSize:         data.sheetSize         ?? null,
      formulaType:       data.formulaType        ?? null,
      preferredVendor:   data.preferredVendor    ?? null,
      notes:             data.notes              ?? null,
      image:             data.image              ?? null,
    });
    return this.lineRepo.save(line);
  }

  /** PATCH /boq/:boqId/lines/:lineId — update a line */
  async updateLine(boqId: number, lineId: number, data: any): Promise<ManufacturingBoqItem> {
    const line = await this.lineRepo.findOneBy({ id: lineId, boqId });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on BOQ ${boqId}`);

    if (data.rawMaterialItemId !== undefined) line.rawMaterialItemId = Number(data.rawMaterialItemId);
    if (data.departmentId      !== undefined) line.departmentId      = Number(data.departmentId);
    if (data.consumptionType   !== undefined) line.consumptionType   = data.consumptionType;
    if (data.qtyPerUnit        !== undefined) {
      const qty = Number(data.qtyPerUnit);
      if (!qty || qty <= 0) throw new BadRequestException('qtyPerUnit must be > 0');
      line.qtyPerUnit = qty;
    }
    if (data.wastagePercent  !== undefined) line.wastagePercent  = Number(data.wastagePercent ?? 0);
    if (data.width           !== undefined) line.width           = data.width  != null ? Number(data.width)  : null;
    if (data.height          !== undefined) line.height          = data.height != null ? Number(data.height) : null;
    if (data.sheetSize       !== undefined) line.sheetSize       = data.sheetSize       ?? null;
    if (data.formulaType     !== undefined) line.formulaType     = data.formulaType     ?? null;
    if (data.preferredVendor !== undefined) line.preferredVendor = data.preferredVendor ?? null;
    if (data.notes           !== undefined) line.notes           = data.notes           ?? null;
    if (data.image           !== undefined) line.image           = data.image           ?? null;

    return this.lineRepo.save(line);
  }

  /** DELETE /boq/:boqId/lines/:lineId */
  async deleteLine(boqId: number, lineId: number): Promise<{ message: string }> {
    const line = await this.lineRepo.findOneBy({ id: lineId, boqId });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on BOQ ${boqId}`);
    await this.lineRepo.remove(line);
    return { message: 'Line deleted' };
  }
}

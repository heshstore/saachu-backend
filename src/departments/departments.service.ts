import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './entities/department.entity';

@Injectable()
export class DepartmentsService {
  private _cache: { data: Department[]; ts: number } | null = null;
  private _allCache: { data: Department[]; ts: number } | null = null;

  constructor(
    @InjectRepository(Department)
    private readonly repo: Repository<Department>,
  ) {}

  async findAll(includeInactive = false): Promise<Department[]> {
    if (includeInactive) {
      if (this._allCache && Date.now() - this._allCache.ts < 600_000)
        return this._allCache.data;
      const data = await this.repo.find({ order: { name: 'ASC' } });
      this._allCache = { data, ts: Date.now() };
      return data;
    }
    if (this._cache && Date.now() - this._cache.ts < 600_000)
      return this._cache.data;
    const data = await this.repo.find({
      where: { active: true },
      order: { name: 'ASC' },
    });
    this._cache = { data, ts: Date.now() };
    return data;
  }

  async create(data: any): Promise<Department> {
    const dept = this.repo.create({
      name: data.name,
      code: data.code,
      dailyCapacity: data.dailyCapacity ?? null,
      capacityUnit: data.capacityUnit ?? null,
      manpowerCapacity: data.manpowerCapacity ?? null,
      active: data.active !== false,
    });
    const saved = await this.repo.save(dept);
    this._cache = null;
    this._allCache = null;
    return saved;
  }

  async update(id: number, data: any): Promise<Department> {
    const dept = await this.repo.findOneBy({ id });
    if (!dept) throw new NotFoundException(`Department ${id} not found`);

    if (data.name !== undefined) dept.name = data.name;
    if (data.code !== undefined) dept.code = data.code;
    if (data.dailyCapacity !== undefined)
      dept.dailyCapacity = data.dailyCapacity ?? null;
    if (data.capacityUnit !== undefined)
      dept.capacityUnit = data.capacityUnit ?? null;
    if (data.manpowerCapacity !== undefined)
      dept.manpowerCapacity = data.manpowerCapacity ?? null;
    if (data.active !== undefined) dept.active = Boolean(data.active);

    const saved = await this.repo.save(dept);
    this._cache = null;
    this._allCache = null;
    return saved;
  }
}

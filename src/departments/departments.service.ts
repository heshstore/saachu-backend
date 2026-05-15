import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './entities/department.entity';

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectRepository(Department)
    private readonly repo: Repository<Department>,
  ) {}

  findAll(includeInactive = false): Promise<Department[]> {
    if (includeInactive) {
      return this.repo.find({ order: { name: 'ASC' } });
    }
    return this.repo.find({ where: { active: true }, order: { name: 'ASC' } });
  }

  async create(data: any): Promise<Department> {
    const dept = this.repo.create({
      name:             data.name,
      code:             data.code,
      dailyCapacity:    data.dailyCapacity    ?? null,
      capacityUnit:     data.capacityUnit     ?? null,
      manpowerCapacity: data.manpowerCapacity ?? null,
      active:           data.active !== false,
    });
    return this.repo.save(dept);
  }

  async update(id: number, data: any): Promise<Department> {
    const dept = await this.repo.findOneBy({ id });
    if (!dept) throw new NotFoundException(`Department ${id} not found`);

    if (data.name             !== undefined) dept.name             = data.name;
    if (data.code             !== undefined) dept.code             = data.code;
    if (data.dailyCapacity    !== undefined) dept.dailyCapacity    = data.dailyCapacity    ?? null;
    if (data.capacityUnit     !== undefined) dept.capacityUnit     = data.capacityUnit     ?? null;
    if (data.manpowerCapacity !== undefined) dept.manpowerCapacity = data.manpowerCapacity ?? null;
    if (data.active           !== undefined) dept.active           = Boolean(data.active);

    return this.repo.save(dept);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import {
  normalizeUserMobile,
  normalizeUserRole,
} from './user-normalization.util';
import { clearJwtCacheForUser } from '../auth/jwt.strategy';

@Injectable()
export class UsersService {
  private _dropdownCache: { data: Partial<User>[]; ts: number } | null = null;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  private normalizeUserOutput<T extends Partial<User>>(
    user: T | null,
  ): T | null {
    if (!user) return user;
    return {
      ...user,
      role: normalizeUserRole(user.role),
      mobile: normalizeUserMobile(user.mobile),
    };
  }

  findAll() {
    return this.userRepository
      .find({ where: { is_active: true } })
      .then((users) => users.map((user) => this.normalizeUserOutput(user)));
  }

  async findForDropdown() {
    if (this._dropdownCache && Date.now() - this._dropdownCache.ts < 300_000) {
      return this._dropdownCache.data;
    }
    const users = await this.userRepository.find({
      where: { is_active: true },
      select: ['id', 'name', 'role', 'marketing_area'],
      order: { name: 'ASC' },
    });
    const result = users.map((user) => this.normalizeUserOutput(user));
    this._dropdownCache = { data: result, ts: Date.now() };
    return result;
  }

  findOne(id: number) {
    return this.userRepository
      .findOne({ where: { id } })
      .then((user) => this.normalizeUserOutput(user));
  }

  async create(data: any) {
    const { password, ...rest } = data;
    const role = normalizeUserRole(rest.role || 'Sales Executive');
    const mobile = normalizeUserMobile(rest.mobile);
    let password_hash: string | undefined;
    if (password) {
      password_hash = await bcrypt.hash(password, 10);
    }
    const email = rest.email?.trim?.() ? String(rest.email).trim() : null;
    const user = this.userRepository.create({
      ...rest,
      email,
      mobile,
      role,
      password_hash,
      can_approve_order: rest.can_approve_order ?? role === 'Admin',
    });
    const saved = await this.userRepository.save(user);
    this._dropdownCache = null;
    const { password_hash: _ph, ...result } = saved as any;
    return this.normalizeUserOutput(result);
  }

  async update(id: number, data: any) {
    if (data.password) {
      data.password_hash = await bcrypt.hash(data.password, 10);
      delete data.password;
    }
    if (data.email !== undefined) {
      data.email = data.email?.trim?.() ? String(data.email).trim() : null;
    }
    if (data.mobile !== undefined) {
      data.mobile = normalizeUserMobile(data.mobile);
    }
    if (data.role !== undefined) {
      data.role = normalizeUserRole(data.role);
      if (data.can_approve_order === undefined) {
        data.can_approve_order = data.role === 'Admin';
      }
    }
    await this.userRepository.update(id, data);
    this._dropdownCache = null;
    clearJwtCacheForUser(id);
    return this.findOne(id);
  }

  async toggleActive(id: number) {
    const user = await this.findOne(id);
    if (!user) throw new Error('User not found');
    await this.userRepository.update(id, { is_active: !user.is_active });
    this._dropdownCache = null;
    clearJwtCacheForUser(id);
    return this.findOne(id);
  }
}

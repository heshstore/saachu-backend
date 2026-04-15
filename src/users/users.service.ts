import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  findAll() {
    return this.userRepository.find({ where: { is_active: true } });
  }

  findOne(id: number) {
    return this.userRepository.findOne({ where: { id } });
  }

  async create(data: any) {
    const role = data.role || 'Sales Executive';
    let password_hash: string | undefined;
    if (data.password) {
      password_hash = await bcrypt.hash(data.password, 10);
    }
    const user = this.userRepository.create({
      ...data,
      role,
      password_hash,
      can_approve_order: data.can_approve_order ?? (role === 'Admin'),
    });
    const saved = await this.userRepository.save(user);
    const { password_hash: _ph, ...result } = saved as any;
    return result;
  }

  async update(id: number, data: any) {
    if (data.password) {
      data.password_hash = await bcrypt.hash(data.password, 10);
      delete data.password;
    }
    await this.userRepository.update(id, data);
    return this.findOne(id);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity.ts';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // 🚀 STRICT MODE PATCH
  async create(data: any) {
    const role = data.role || 'Sales Executive';
    const user = this.userRepository.create({
      ...data,
      role: role,
      can_approve_order: role === 'Admin',
    });
    return await this.userRepository.save(user);
  }
}

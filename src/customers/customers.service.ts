import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './entities/customer.entity';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private customerRepo: Repository<Customer>,
  ) {}

  async create(data: any) {
    const customer = this.customerRepo.create(data);
    return this.customerRepo.save(customer);
  }

  findAll() {
    return this.customerRepo.find();
  }

  findOne(id: number) {
    return this.customerRepo.findOne({ where: { id } });
  }

  async update(id: number, data: any) {
    await this.customerRepo.update(id, data);
    return this.findOne(id);
  }

  remove(id: number) {
    return this.customerRepo.delete(id);
  }
}
import { Injectable, BadRequestException } from '@nestjs/common';
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

    // ✅ NORMALIZE INPUT
    const tag = data.tag?.trim().toLowerCase();

    // 🔥 NORMALIZE MOBILE (REMOVE +91, SPACES, ETC)
    let mobile1 = data.mobile1?.replace(/\D/g, "");

    // Normalize to 10 digits ONLY (store without +91)
    if (mobile1 && mobile1.length === 12 && mobile1.startsWith("91")) {
      mobile1 = mobile1.slice(2);
    }

    let gstNumber = data.gstNumber?.trim();
    // Convert empty string to null
    if (!gstNumber) {
      gstNumber = null;
    }

    data.tag = tag;
    data.mobile1 = mobile1;
    data.gstNumber = gstNumber;

    // 🔒 DUPLICATE CHECK - MOBILE
    const existingMobile = await this.customerRepo.findOne({
      where: { mobile1 }
    });
    if (existingMobile) {
      throw new BadRequestException("Mobile already exists");
    }

    // 🔒 DUPLICATE CHECK - composite (companyName + tag + city)
    const existingCombo = await this.customerRepo.findOne({
      where: { companyName: data.companyName, tag, city: data.city },
    });
    if (existingCombo) {
      throw new BadRequestException(
        `A customer "${data.companyName}" with tag "${tag}" in "${data.city}" already exists`,
      );
    }

    // 🔒 DUPLICATE CHECK - GST (ONLY IF PROVIDED)
    if (data.gstNumber) {
      const existingGst = await this.customerRepo.findOne({
        where: { gstNumber: data.gstNumber }
      });
      if (existingGst) {
        throw new BadRequestException("GST already exists");
      }
    }

    try {
      return await this.customerRepo.save(data);
    } catch (error) {
      if (error.code === '23505') {
        throw new BadRequestException("Duplicate entry not allowed");
      }
      throw error;
    }
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
import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Customer } from './entities/customer.entity';

@Controller('customers')
export class CustomersController {
  
  // ✅ SINGLE CONSTRUCTOR (MERGED)
  constructor(
    private readonly customersService: CustomersService,

    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
  ) {}

  // ✅ SEARCH API (WORKING)
  @Get('search')
  async searchCustomers(@Query('q') q: string) {
    return this.customerRepository.find({
      where: [
        { companyName: ILike(`%${q}%`) },
        { mobile1: ILike(`%${q}%`) },
        { city: ILike(`%${q}%`) },
        { gstNumber: ILike(`%${q}%`) },
        { tag: ILike(`%${q}%`) },
      ],
      take: 10,
    });
  }

  // ✅ CREATE
  @Post()
  create(@Body() body) {
    return this.customersService.create(body);
  }

  // ✅ GET ALL
  @Get()
  findAll() {
    return this.customersService.findAll();
  }

  // ✅ GET ONE
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(Number(id));
  }
}
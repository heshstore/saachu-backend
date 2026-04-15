import { Controller, Get, Post, Body, Param, Query, Put, Delete, Patch } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { Public } from '../auth/public.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Customer } from './entities/customer.entity';

@Public()
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

  @Put(':id')
  update(@Param('id') id: string, @Body() body) {
    return this.customersService.update(Number(id), body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customersService.remove(Number(id));
  }

  @Patch(':id/credit-limit')
  updateCreditLimit(@Param('id') id: string, @Body() body: { credit_days: number; credit_limit_amount: number }) {
    return this.customersService.update(Number(id), {
      credit_days: body.credit_days,
      creditLimit: body.credit_limit_amount,
    });
  }
}
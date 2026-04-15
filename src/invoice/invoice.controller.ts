import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('invoice')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Get('test')
  test() {
    return { message: 'Invoice route working' };
  }

  @Get()
  findAll() {
    return this.invoiceService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.invoiceService.findOne(Number(id));
  }

  @Post('from-order/:id')
  createFromOrder(
    @Param('id') id: string,
    @Body() body: { type?: 'TALLY' | 'ESTIMATE' },
  ) {
    return this.invoiceService.createFromOrder(+id, body?.type ?? 'TALLY');
  }
}
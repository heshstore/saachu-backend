import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { InvoiceService } from './invoice.service';

@Controller('invoice')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  // ✅ SIMPLE TEST ROUTE (VERY IMPORTANT)
  @Get('test')
  test() {
    return { message: 'Invoice route working' };
  }

  // ✅ MAIN ROUTE
  @Post('from-order/:id')
  createFromOrder(
    @Param('id') id: string,
    @Body() body: { gst_percent: number }
  ) {
    return this.invoiceService.createFromOrder(
      +id,
      body?.gst_percent ?? 100
    );
  }
}
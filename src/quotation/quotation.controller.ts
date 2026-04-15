import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  Request,
} from '@nestjs/common';
import { QuotationService } from './quotation.service';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('quotations')
export class QuotationController {
  constructor(private readonly quotationService: QuotationService) {}

  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.quotationService.create(body, req.user);
  }

  @Get()
  findAll(@Query() query: any) {
    return this.quotationService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.quotationService.findOne(Number(id));
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.quotationService.update(Number(id), body, req.user);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.cancel(Number(id), req.user);
  }

  @Post(':id/convert-to-order')
  convertToOrder(@Param('id') id: string, @Request() req: any) {
    return this.quotationService.convertToOrder(Number(id), req.user);
  }
}

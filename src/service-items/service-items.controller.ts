import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common';
import { ServiceItemsService } from './service-items.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('service-items')
export class ServiceItemsController {
  constructor(private readonly svc: ServiceItemsService) {}

  @Get()
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.svc.findById(+id);
  }

  @Post()
  @RequirePermission('item.create')
  create(@Body() data: any) {
    return this.svc.create(data);
  }

  @Patch(':id')
  @RequirePermission('item.edit')
  update(@Param('id') id: string, @Body() data: any) {
    return this.svc.update(+id, data);
  }

  @Delete(':id')
  @RequirePermission('item.edit')
  softDelete(@Param('id') id: string) {
    return this.svc.softDelete(+id);
  }
}

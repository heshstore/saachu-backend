import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { VendorsService } from './vendors.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('vendors')
export class VendorsController {
  constructor(private readonly svc: VendorsService) {}

  @Get()
  @RequirePermission('inventory.view')
  findAll(@Query('search') search?: string, @Query('active') active?: string) {
    return this.svc.findAll({ search, active });
  }

  @Get(':id')
  @RequirePermission('inventory.view')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(+id);
  }

  @Post()
  @RequirePermission('inventory.manage')
  create(@Body() body: any) {
    return this.svc.create(body);
  }

  @Patch(':id')
  @RequirePermission('inventory.manage')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.update(+id, body);
  }
}

@Controller('vendor-item-mappings')
export class VendorItemMappingsController {
  constructor(private readonly svc: VendorsService) {}

  @Get()
  @RequirePermission('inventory.view')
  findForItem(
    @Query('itemId') itemId: string,
    @Query('itemSource') itemSource?: string,
  ) {
    if (!itemId) return [];
    return this.svc.findMappingsForItem(
      +itemId,
      (itemSource || 'SERVICE').toUpperCase(),
    );
  }

  @Post()
  @RequirePermission('inventory.manage')
  create(@Body() body: any) {
    return this.svc.createMapping(body);
  }

  @Patch(':id')
  @RequirePermission('inventory.manage')
  update(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateMapping(+id, body);
  }

  @Delete(':id')
  @RequirePermission('inventory.manage')
  remove(@Param('id') id: string) {
    return this.svc.deleteMapping(+id);
  }
}

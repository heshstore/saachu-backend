import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly svc: DepartmentsService) {}

  @Get()
  @RequirePermission('production.view')
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.svc.findAll(includeInactive === 'true');
  }

  @Post()
  @RequirePermission('production.update')
  create(@Body() data: any) {
    return this.svc.create(data);
  }

  @Patch(':id')
  @RequirePermission('production.update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.svc.update(+id, data);
  }
}

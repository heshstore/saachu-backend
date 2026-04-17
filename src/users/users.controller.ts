import { Controller, Get, Post, Put, Patch, Param, Body } from '@nestjs/common';
import { UsersService } from './users.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** Full staff list with all fields — requires staff.view */
  @Get()
  @RequirePermission('staff.view')
  findAll() {
    return this.usersService.findAll();
  }

  /** Lightweight list for dropdowns (salesman selection etc.) — any authenticated user */
  @Get('dropdown')
  findForDropdown() {
    return this.usersService.findForDropdown();
  }

  @Get(':id')
  @RequirePermission('staff.view')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(Number(id));
  }

  @Post()
  @RequirePermission('staff.create')
  create(@Body() body: any) {
    return this.usersService.create(body);
  }

  @Put(':id')
  @RequirePermission('staff.edit')
  update(@Param('id') id: string, @Body() body: any) {
    return this.usersService.update(Number(id), body);
  }

  @Patch(':id/deactivate')
  @RequirePermission('staff.deactivate')
  deactivate(@Param('id') id: string) {
    return this.usersService.toggleActive(Number(id));
  }
}

import { Controller, Get, Post, Put, Delete, Body, Param, HttpCode } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('rbac')
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  /** Full matrix for the UI — Admin only */
  @Get('matrix')
  @RequirePermission('rbac.manage')
  getMatrix() {
    return this.rbacService.getMatrix();
  }

  /** Save full matrix — Admin only */
  @Post('matrix')
  @RequirePermission('rbac.manage')
  saveMatrix(@Body() body: { data: { roleId: number; permissionIds: number[] }[] }) {
    return this.rbacService.saveMatrix(body.data);
  }

  /** List all active roles — used by Staff Management dropdown */
  @Get('roles')
  getRoles() {
    return this.rbacService.getAllRoles();
  }

  /** Add a new role dynamically — Admin only */
  @Post('roles')
  @RequirePermission('rbac.manage')
  createRole(@Body() body: { name: string }) {
    return this.rbacService.createRole(body.name);
  }

  /** Rename a role — Admin only */
  @Put('roles/:id')
  @RequirePermission('rbac.manage')
  renameRole(@Param('id') id: string, @Body() body: { name: string }) {
    return this.rbacService.renameRole(Number(id), body.name);
  }

  /** Delete a non-system role — Admin only */
  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermission('rbac.manage')
  deleteRole(@Param('id') id: string) {
    return this.rbacService.deleteRole(Number(id));
  }
}

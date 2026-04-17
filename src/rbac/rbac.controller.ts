import { Controller, Get, Post, Body } from '@nestjs/common';
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
}

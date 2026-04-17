import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacService } from '../rbac/rbac.service';
import { PERMISSION_KEY } from './require-permission.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private rbacService: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermission decorator — allow any authenticated user through
    if (!required) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user?.role) return false;
    if (user.role === 'Admin') return true;

    const perms = await this.rbacService.getPermissionsForRole(user.role);
    return perms.includes(required);
  }
}

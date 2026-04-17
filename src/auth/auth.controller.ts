import { Controller, Post, Patch, Get, Body, HttpCode, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RbacService } from '../rbac/rbac.service';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rbacService: RbacService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { mobile?: string; email?: string; password?: string }) {
    const loginId = (body.mobile ?? body.email ?? '').trim();
    return this.authService.login(loginId, (body.password ?? '').trim());
  }

  /** Returns fresh permissions for the current session — call after RBAC matrix changes */
  @Get('me/permissions')
  async getMyPermissions(@Req() req: Request) {
    const user = (req as any).user;
    const permissions = await this.rbacService.getPermissionsForRole(user.role);
    return { permissions };
  }

  @Patch('change-password')
  @HttpCode(200)
  async changePassword(
    @Req() req: Request,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    const user = (req as any).user;
    await this.authService.changePassword(user.id, body.currentPassword, body.newPassword);
    return { message: 'Password changed successfully' };
  }
}

import { Controller, Post, Patch, Body, HttpCode, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { mobile?: string; email?: string; password?: string }) {
    const loginId = (body.mobile ?? body.email ?? '').trim();
    return this.authService.login(loginId, (body.password ?? '').trim());
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

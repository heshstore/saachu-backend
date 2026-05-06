import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

const isDev = process.env.NODE_ENV !== 'production';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    if (isDev) {
      const req = context.switchToHttp().getRequest();
      const authHeader = req.headers?.authorization ?? null;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      console.log(`[Auth] ${req.method} ${req.url} | header: ${authHeader ? 'present' : 'MISSING'} | token: ${token ? `${token.slice(0, 20)}...` : 'NONE'}`);
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      const reason = err?.message ?? info?.message ?? info?.name ?? 'Unknown reason';
      if (isDev) console.warn(`[Auth] JWT rejected — ${reason}`);
      throw err ?? new UnauthorizedException(reason);
    }
    return user;
  }
}

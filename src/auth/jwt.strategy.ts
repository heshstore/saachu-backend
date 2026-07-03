import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { appConfig } from '../config/config';
import { User } from '../users/entities/user.entity';

const JWT_CACHE_TTL = 30_000;
const _jwtCache = new Map<
  number,
  { user: ReturnType<JwtStrategy['buildPayload']>; ts: number }
>();

export function clearJwtCacheForUser(userId: number): void {
  _jwtCache.delete(userId);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'), // for SSE (EventSource can't set headers)
      ]),
      ignoreExpiration: false,
      secretOrKey: appConfig.jwtSecret,
    });
  }

  buildPayload(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
      can_approve_order: user.can_approve_order,
    };
  }

  async validate(payload: any) {
    const cached = _jwtCache.get(payload.sub);
    if (cached && Date.now() - cached.ts < JWT_CACHE_TTL) {
      return cached.user;
    }

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });

    if (!user || !user.is_active) {
      _jwtCache.delete(payload.sub);
      throw new UnauthorizedException('Account not found or inactive');
    }

    const result = this.buildPayload(user);
    _jwtCache.set(payload.sub, { user: result, ts: Date.now() });
    return result;
  }
}

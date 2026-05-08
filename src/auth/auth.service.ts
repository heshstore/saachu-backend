import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { User } from '../users/entities/user.entity';
import { RbacService } from '../rbac/rbac.service';
import { normalizeUserMobile, normalizeUserRole } from '../users/user-normalization.util';

/** Last up to 10 digits of input (matches DB mobile with or without country code). */
function mobileMatchKey(input: string): string {
  const d = (input || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length > 10 ? d.slice(-10) : d;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private jwtService: JwtService,
    private rbacService: RbacService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async login(loginId: string, password: string) {
    const trimmed = (loginId || '').trim();
    const loginType = trimmed.includes('@') ? 'email' : 'mobile';
    console.log(`[Auth:Service] Login attempt | type=${loginType} | loginId="${trimmed}"`);

    if (!trimmed || !password) {
      console.warn('[Auth:Service] Rejected: empty credentials');
      throw new UnauthorizedException('Invalid mobile or password');
    }

    let user: User | null = null;

    if (trimmed.includes('@')) {
      user = await this.userRepo
        .createQueryBuilder('user')
        .addSelect('user.password_hash')
        .where('LOWER(user.email) = LOWER(:email)', { email: trimmed })
        .getOne();
    } else {
      const key = mobileMatchKey(trimmed);
      console.log(`[Auth:Service] Mobile lookup key="${key}"`);
      if (!key) {
        console.warn('[Auth:Service] Rejected: could not derive mobile key');
        throw new UnauthorizedException('Invalid mobile or password');
      }
      user = await this.userRepo
        .createQueryBuilder('user')
        .addSelect('user.password_hash')
        .where(
          `(RIGHT(REGEXP_REPLACE(COALESCE(user.mobile, ''), '[^0-9]', '', 'g'), 10) = :key
            OR REGEXP_REPLACE(COALESCE(user.mobile, ''), '[^0-9]', '', 'g') = :keyExact
            OR TRIM(user.mobile) = :raw)`,
          { key, keyExact: trimmed.replace(/\D/g, ''), raw: trimmed },
        )
        .getOne();
    }

    if (!user) {
      console.warn(`[Auth:Service] User NOT found for loginId="${trimmed}"`);
      throw new UnauthorizedException('Invalid mobile or password');
    }

    console.log(`[Auth:Service] User found | id=${user.id} name="${user.name}" role="${user.role}" mobile="${user.mobile}" passwordHashPresent=${!!user.password_hash}`);

    const normalizedRole = normalizeUserRole(user.role);
    const normalizedMobile = normalizeUserMobile(user.mobile);
    if (normalizedRole !== (user.role || '') || normalizedMobile !== (user.mobile || null)) {
      const patch: Partial<User> = {};
      if (normalizedRole !== (user.role || '')) patch.role = normalizedRole;
      if (normalizedMobile !== (user.mobile || null)) patch.mobile = normalizedMobile;
      await this.userRepo.update(user.id, patch);
      Object.assign(user, patch);
    }

    if (!user.password_hash) {
      console.error(`[Auth:Service] No password_hash set for uid=${user.id} — account not configured`);
      throw new UnauthorizedException('Account not set up. Contact admin.');
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    console.log(`[Auth:Service] bcrypt.compare result=${isMatch} for uid=${user.id}`);

    if (!isMatch) {
      console.warn(`[Auth:Service] Password mismatch for uid=${user.id} loginId="${trimmed}"`);
      throw new UnauthorizedException('Invalid mobile or password');
    }

    if (!user.is_active) {
      console.warn(`[Auth:Service] Account inactive uid=${user.id}`);
      throw new UnauthorizedException('Account is inactive');
    }

    const permissions = await this.rbacService.getPermissionsForRole(normalizedRole);

    const payload = {
      sub: user.id,
      name: user.name,
      email: user.email,
      mobile: normalizedMobile,
      role: normalizedRole,
      can_approve_order: user.can_approve_order,
    };

    console.log(`[Auth:Service] Login SUCCESS | uid=${user.id} name="${user.name}" role=${normalizedRole}`);
    this.eventEmitter.emit('auth.login', { user_id: user.id, name: user.name, role: normalizedRole, ip: null });
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: normalizedMobile,
        role: normalizedRole,
        can_approve_order: user.can_approve_order,
      },
      permissions,
    };
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.id = :id', { id: userId })
      .getOne();

    if (!user) throw new UnauthorizedException('User not found');
    if (!user.password_hash) throw new UnauthorizedException('No password set');

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) throw new UnauthorizedException('Current password is incorrect');

    const newHash = await bcrypt.hash(newPassword, 10);
    await this.userRepo.update(userId, { password_hash: newHash } as any);
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 10);
  }
}

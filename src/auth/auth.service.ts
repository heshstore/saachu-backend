import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
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
  ) {}

  async login(loginId: string, password: string) {
    const trimmed = (loginId || '').trim();
    this.logger.log(`Login attempt: "${trimmed}"`);
    if (!trimmed || !password) {
      this.logger.warn(`Login rejected: empty credentials`);
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
      if (!key) {
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
      this.logger.warn(`Login failed: no user found for "${trimmed}"`);
      throw new UnauthorizedException('Invalid mobile or password');
    }

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
      throw new UnauthorizedException('Account not set up. Contact admin.');
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      this.logger.warn(`Login failed: wrong password for uid=${user.id} (${trimmed})`);
      throw new UnauthorizedException('Invalid mobile or password');
    }

    if (!user.is_active) {
      this.logger.warn(`Login failed: inactive account uid=${user.id}`);
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

    this.logger.log(`Login success: uid=${user.id} name="${user.name}" role=${normalizedRole}`);
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

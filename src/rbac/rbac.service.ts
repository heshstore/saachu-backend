import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Role } from './role.entity';
import { Permission } from './permission.entity';

// Permission dependency map — if key is granted, deps are auto-granted too
export const PERMISSION_DEPS: Record<string, string[]> = {
  'customer.create':   ['customer.view'],
  'customer.edit':     ['customer.view'],
  'customer.delete':   ['customer.view'],
  'item.create':       ['item.view'],
  'item.edit':         ['item.view'],
  'item.shopify_sync': ['item.view'],
  'quotation.create':  ['quotation.view'],
  'quotation.edit':    ['quotation.view'],
  'quotation.cancel':  ['quotation.view'],
  'quotation.convert': ['quotation.view', 'order.create', 'order.view'],
  'order.create':      ['order.view'],
  'order.edit':        ['order.view'],
  'order.cancel':      ['order.view'],
  'order.approve':     ['order.view'],
  'order.reject':      ['order.view'],
  'invoice.create':    ['invoice.view'],
  'payment.create':    ['payment.view'],
  'dispatch.create':   ['dispatch.view'],
  'production.update': ['production.view'],
  'staff.create':      ['staff.view'],
  'staff.edit':        ['staff.view'],
  'staff.deactivate':  ['staff.view'],
  'rbac.manage':       ['staff.view', 'settings.view'],
  // CRM
  'lead.create':         ['lead.view'],
  'lead.edit':           ['lead.view'],
  'lead.delete':         ['lead.view'],
  'lead.assign':         ['lead.view'],
  'lead.convert':        ['lead.view', 'customer.create', 'quotation.create'],
  'crm.analytics.team':  ['crm.analytics.self'],
  'crm.analytics.all':   ['crm.analytics.team', 'crm.analytics.self'],
};

@Injectable()
export class RbacService implements OnModuleInit {
  // In-memory cache: roleName -> Set<permissionKey>
  private cache = new Map<string, Set<string>>();

  constructor(
    @InjectRepository(Role)
    private roleRepo: Repository<Role>,
    @InjectRepository(Permission)
    private permRepo: Repository<Permission>,
  ) {}

  async onModuleInit() {
    await this.refreshCache();
  }

  async refreshCache() {
    const roles = await this.roleRepo.find({ relations: ['permissions'] });
    this.cache.clear();
    for (const role of roles) {
      this.cache.set(role.name, new Set((role.permissions || []).map(p => p.key)));
    }
  }

  async getPermissionsForRole(roleName: string): Promise<string[]> {
    if (!this.cache.has(roleName)) {
      await this.refreshCache();
    }
    return Array.from(this.cache.get(roleName) || []);
  }

  async getAllRoles(): Promise<Role[]> {
    return this.roleRepo.find({ where: { is_active: true }, order: { id: 'ASC' } });
  }

  async getAllPermissions(): Promise<Permission[]> {
    return this.permRepo.find({ order: { module: 'ASC', id: 'ASC' } });
  }

  async getMatrix() {
    const roles = await this.getAllRoles();
    const permissions = await this.getAllPermissions();
    const matrix: Record<number, number[]> = {};
    for (const role of roles) {
      const full = await this.roleRepo.findOne({ where: { id: role.id }, relations: ['permissions'] });
      matrix[role.id] = (full?.permissions || []).map(p => p.id);
    }
    return { roles, permissions, matrix };
  }

  /** Enforce dependencies: add all prerequisites for each granted key */
  private resolveDeps(keys: string[]): string[] {
    const resolved = new Set<string>(keys);
    let changed = true;
    while (changed) {
      changed = false;
      for (const key of [...resolved]) {
        for (const dep of (PERMISSION_DEPS[key] || [])) {
          if (!resolved.has(dep)) {
            resolved.add(dep);
            changed = true;
          }
        }
      }
    }
    return Array.from(resolved);
  }

  async saveMatrix(data: { roleId: number; permissionIds: number[] }[]) {
    // Load all permissions for key lookup
    const allPerms = await this.permRepo.find();
    const idToKey = new Map(allPerms.map(p => [p.id, p.key]));
    const keyToId = new Map(allPerms.map(p => [p.key, p.id]));

    for (const { roleId, permissionIds } of data) {
      const role = await this.roleRepo.findOne({ where: { id: roleId }, relations: ['permissions'] });
      if (!role) continue;

      // Resolve dependencies server-side
      const keys = permissionIds.map(id => idToKey.get(id)).filter(Boolean) as string[];
      const resolvedKeys = this.resolveDeps(keys);
      const resolvedIds = resolvedKeys
        .map(k => keyToId.get(k))
        .filter((id): id is number => id !== undefined);

      const permsToAssign = resolvedIds.length > 0
        ? await this.permRepo.findBy({ id: In(resolvedIds) })
        : [];
      role.permissions = permsToAssign;
      await this.roleRepo.save(role);
    }

    await this.refreshCache();
  }

  async createRole(name: string): Promise<Role> {
    const existing = await this.roleRepo.findOne({ where: { name } });
    if (existing) return existing;
    const role = this.roleRepo.create({ name, is_system: false });
    const saved = await this.roleRepo.save(role);
    await this.refreshCache();
    return saved;
  }

  async renameRole(id: number, name: string): Promise<Role> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new Error('Role not found');
    role.name = name.trim();
    const saved = await this.roleRepo.save(role);
    await this.refreshCache();
    return saved;
  }

  async deleteRole(id: number): Promise<void> {
    const role = await this.roleRepo.findOne({ where: { id } });
    if (!role) throw new Error('Role not found');
    if (role.is_system) throw new Error('Cannot delete system roles');
    await this.roleRepo.remove(role);
    await this.refreshCache();
  }
}
